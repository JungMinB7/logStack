import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  EMPTY_BATCH_BODY_BYTES,
  type EventInput,
} from '../../scripts/send-events';
import { failedJournalIds } from './failed-journal';

export const FAILED_ID_CACHE_LIMIT = 100_000;

/** 확인(체크포인트) 완료 바이트가 이 값을 넘으면 저널을 컴팩션한다 */
export const COMPACT_THRESHOLD_BYTES = 4 * 1024 * 1024;

interface PendingEntry {
  event: EventInput;
  /** 저널에서 이 이벤트 한 줄이 차지하는 바이트 (개행 포함) */
  bytes: number;
  /** 배치 JSON에서 이벤트 자체가 차지하는 바이트 */
  eventBytes: number;
}

interface CheckpointState {
  offset: number;
  /** 이전 컴팩션들에서 저널로부터 제거된 누적 이벤트 수 */
  journalBaseCount: number;
  /** 현재 저널의 확인 완료 prefix 이벤트 수 */
  confirmedSinceCompaction: number;
}

interface CompactionManifest {
  checkpoint: CheckpointState;
}

interface JournalEntry extends PendingEntry {
  start: number;
  end: number;
}

/**
 * outbox — append 전용 JSON Lines 저널 + fsync [A-26].
 *
 * 구조:
 * - outbox.jsonl    : 생성 이벤트 append(fsync). 확인분은 byte offset으로 관리
 * - checkpoint.json : offset과 컴팩션 누적 카운터. tmp+fsync+rename 원자 갱신
 * - failed.jsonl    : rejected·400·단일 413 이벤트의 영속 실패 저장소
 *
 * 컴팩션은 manifest를 먼저 영속화한 뒤 journal rename과 checkpoint 갱신을 한다.
 * 어느 지점에서 SIGKILL되어도 다음 open이 manifest를 완료하므로, 새 journal에 예전
 * offset을 적용해 미확인 이벤트를 건너뛰는 크래시 창이 없다.
 *
 * append 도중 생긴 마지막 불완전 라인은 fsync가 완료되지 않은 기록이다. open 시
 * 실제 파일을 마지막 개행까지 truncate+fsync한 후 append를 재개한다. 메모리에서만
 * 무시하면 다음 정상 이벤트가 손상 suffix에 붙어 함께 유실될 수 있다.
 */
export class Outbox {
  private fd: number;
  private pending: PendingEntry[] = [];
  private checkpointOffset = 0;
  private journalBaseCount = 0;
  private confirmedSinceCompaction = 0;
  private journalEntryCount = 0;
  /** Bounded cache; misses scan the durable journal synchronously after overflow.
   * Each miss is O(journal bytes). Startup counts unique overflow IDs by scanning
   * preceding records (worst-case quadratic I/O), without an unbounded second set.
   * Memory is O(cache limit + largest JSON line + 64 KiB). Single writer only.
   */
  private readonly failedEventIds = new Set<string>();
  private failedUniqueCount = 0;
  private failedWriteFault = false;
  private closed = false;
  /** 크래시 후 실제로 잘라낸 outbox 마지막 불완전 라인 수 (관측용) */
  readonly truncatedLines: number;

  private constructor(
    private readonly dir: string,
    private readonly failedIdCacheLimit: number,
  ) {
    if (!Number.isInteger(failedIdCacheLimit) || failedIdCacheLimit < 0) {
      throw new Error('invalid failed ID cache limit');
    }
    mkdirSync(dir, { recursive: true });
    this.recoverCompaction();
    this.truncatedLines = this.truncateIncompleteTail(this.journalPath);
    this.truncateIncompleteTail(this.failedPath);

    const state = this.loadCheckpoint();
    const journal = this.loadJournal();
    this.journalEntryCount = journal.length;
    this.loadFailedEventIds();

    const boundaries = new Set<number>([0, ...journal.map((entry) => entry.end)]);
    if (
      state.offset > statSize(this.journalPath) ||
      !boundaries.has(state.offset)
    ) {
      // 손상된/옛 체크포인트로 tail 중간을 건너뛰지 않는다. 전량 재전송이 안전하다.
      state.offset = 0;
      state.confirmedSinceCompaction = 0;
    }

    const confirmedInJournal = journal.filter(
      (entry) => entry.end <= state.offset,
    ).length;
    // 구버전 {offset} 체크포인트 마이그레이션 및 손상 방어.
    if (state.confirmedSinceCompaction !== confirmedInJournal) {
      state.confirmedSinceCompaction = confirmedInJournal;
    }

    this.checkpointOffset = state.offset;
    this.journalBaseCount = state.journalBaseCount;
    this.confirmedSinceCompaction = state.confirmedSinceCompaction;
    this.pending = journal
      .filter((entry) => entry.start >= this.checkpointOffset)
      .map(({ event, bytes, eventBytes }) => ({ event, bytes, eventBytes }));
    this.persistCheckpoint();
    const journalExisted = existsSync(this.journalPath);
    this.fd = openSync(this.journalPath, 'a');
    if (!journalExisted) this.fsyncDirectory();
  }

  static open(dir: string, failedIdCacheLimit = FAILED_ID_CACHE_LIMIT): Outbox {
    return new Outbox(dir, failedIdCacheLimit);
  }

  private get journalPath(): string {
    return join(this.dir, 'outbox.jsonl');
  }
  private get checkpointPath(): string {
    return join(this.dir, 'checkpoint.json');
  }
  private get failedPath(): string {
    return join(this.dir, 'failed.jsonl');
  }
  private get compactPath(): string {
    return `${this.journalPath}.compact`;
  }
  private get compactManifestPath(): string {
    return join(this.dir, 'compaction.json');
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get pendingBytes(): number {
    return this.pending.reduce((sum, entry) => sum + entry.bytes, 0);
  }

  /** 컴팩션과 무관한 누적 선기록 수 — 통합 무유실 회계의 독립 기준값 */
  get recordedCount(): number {
    return this.journalBaseCount + this.journalEntryCount;
  }

  get failedCount(): number {
    return this.failedUniqueCount;
  }

  get cachedFailedIdCount(): number {
    return this.failedEventIds.size;
  }

  /** 이벤트들을 저널에 append하고 fsync — 반환 후에야 기록 성공 [A-26] */
  appendMany(events: EventInput[]): void {
    if (events.length === 0) return;
    const lines = events.map((event) => `${JSON.stringify(event)}\n`);
    writeAll(this.fd, lines.join(''));
    fsyncSync(this.fd);
    for (let index = 0; index < events.length; index += 1) {
      this.pending.push({
        event: events[index],
        bytes: Buffer.byteLength(lines[index], 'utf8'),
        eventBytes: Buffer.byteLength(JSON.stringify(events[index]), 'utf8'),
      });
    }
    this.journalEntryCount += events.length;
  }

  /** 실제 batch envelope까지 포함해 maxCount/maxBytes를 넘지 않는 head를 반환 */
  peekBatch(maxCount: number, maxBytes: number): EventInput[] {
    const batch: EventInput[] = [];
    let bytes = EMPTY_BATCH_BODY_BYTES;
    for (const entry of this.pending) {
      if (batch.length >= maxCount) break;
      const additionalBytes = entry.eventBytes + (batch.length === 0 ? 0 : 1);
      if (batch.length > 0 && bytes + additionalBytes > maxBytes) break;
      batch.push(entry.event);
      bytes += additionalBytes;
    }
    return batch;
  }

  /** head의 연속 count건을 확인하고 byte checkpoint를 영속화한다. */
  confirm(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > this.pending.length) {
      throw new Error(`invalid outbox confirm count: ${count}`);
    }
    if (count === 0) return;
    const confirmed = this.pending.splice(0, count);
    this.checkpointOffset += confirmed.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    this.confirmedSinceCompaction += confirmed.length;
    this.persistCheckpoint();
    if (this.checkpointOffset >= COMPACT_THRESHOLD_BYTES) this.compact();
  }

  /**
   * 실패 이벤트를 event_id 기준 한 번만 실패 저널로 이동한다. 실패 fsync 후에만
   * 반환하므로 그 다음 checkpoint 전진 중 죽어도 재시작 시 중복 격리되지 않는다.
   */
  quarantine(
    events: EventInput[],
    reason: string,
    detail: Record<string, unknown> = {},
  ): number {
    if (this.failedWriteFault) throw new Error('failed journal write fault; reopen required');
    const seenThisCall = new Set<string>();
    const newEvents = events.filter((event) => {
      if (
        seenThisCall.has(event.event_id) ||
        this.hasFailedId(event.event_id)
      ) {
        return false;
      }
      seenThisCall.add(event.event_id);
      return true;
    });
    if (newEvents.length === 0) return 0;

    let fd: number | undefined;
    try {
      fd = openSync(this.failedPath, 'a');
      const lines = newEvents
        .map((event) =>
          JSON.stringify({
            quarantined_at: new Date().toISOString(),
            ...detail,
            reason,
            event,
          }),
        )
        .join('\n');
      writeAll(fd, `${lines}\n`);
      fsyncSync(fd);
      this.fsyncDirectory();
    } catch (error) {
      // A failed write/fsync may have persisted a prefix. Do not retry against stale
      // cache state in this process; reopen repairs the tail and reloads the journal.
      this.failedWriteFault = true;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    for (const event of newEvents) {
      this.cacheFailedId(event.event_id);
      this.failedUniqueCount += 1;
    }
    return newEvents.length;
  }

  close(): void {
    if (this.closed) return;
    closeSync(this.fd);
    this.closed = true;
  }

  // ── 내부 ─────────────────────────────────────────────────

  private loadCheckpoint(): CheckpointState {
    const fallback: CheckpointState = {
      offset: 0,
      journalBaseCount: 0,
      confirmedSinceCompaction: 0,
    };
    if (!existsSync(this.checkpointPath)) return fallback;
    try {
      const value = JSON.parse(
        readFileSync(this.checkpointPath, 'utf8'),
      ) as Record<string, unknown>;
      return {
        offset: nonNegativeInteger(value.offset) ?? 0,
        journalBaseCount: nonNegativeInteger(value.journalBaseCount) ?? 0,
        confirmedSinceCompaction:
          nonNegativeInteger(value.confirmedSinceCompaction) ?? 0,
      };
    } catch {
      return fallback; // 손상 시 유실 대신 현재 저널 전량 재전송
    }
  }

  private checkpointState(): CheckpointState {
    return {
      offset: this.checkpointOffset,
      journalBaseCount: this.journalBaseCount,
      confirmedSinceCompaction: this.confirmedSinceCompaction,
    };
  }

  private persistCheckpoint(state = this.checkpointState()): void {
    this.writeAtomicJson(this.checkpointPath, state);
  }

  private loadJournal(): JournalEntry[] {
    if (!existsSync(this.journalPath)) return [];
    const buffer = readFileSync(this.journalPath);
    const entries: JournalEntry[] = [];
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline < 0) throw new Error('outbox journal tail repair failed');
      const end = newline + 1;
      const line = buffer.subarray(start, newline).toString('utf8');
      try {
        const event = JSON.parse(line) as unknown;
        if (!isEventRecord(event)) throw new Error('invalid event record');
        entries.push({
          event,
          start,
          end,
          bytes: end - start,
          eventBytes: Buffer.byteLength(JSON.stringify(event), 'utf8'),
        });
      } catch {
        // 개행까지 영속된 중간 손상은 "미완 기록"이 아니다. 조용히 버리면 유실이다.
        throw new Error(`outbox journal contains invalid JSON at byte ${start}`);
      }
      start = end;
    }
    return entries;
  }

  private loadFailedEventIds(): void {
    try {
      statSync(this.failedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const { id, offset } of failedJournalIds(this.failedPath)) {
      if (!this.hasFailedId(id, offset)) {
        this.cacheFailedId(id);
        this.failedUniqueCount += 1;
      }
    }
  }

  private cacheFailedId(id: string): void {
    if (this.failedEventIds.size < this.failedIdCacheLimit) this.failedEventIds.add(id);
  }

  private hasFailedId(id: string, end = Infinity): boolean {
    if (this.failedEventIds.has(id)) return true;
    if (this.failedUniqueCount <= this.failedEventIds.size) return false;
    for (const entry of failedJournalIds(this.failedPath, end)) {
      if (entry.id === id) return true;
    }
    return false;
  }

  /** 마지막 개행 뒤의 미완전 suffix를 실제 파일에서 제거하고 fsync한다. */
  private truncateIncompleteTail(path: string): number {
    let fd: number;
    try {
      fd = openSync(path, 'r+');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return 0;
      const block = Buffer.alloc(64 * 1024);
      let position = size;
      let length = 0;
      while (position > 0) {
        const count = Math.min(block.length, position);
        position -= count;
        const read = readSync(fd, block, 0, count, position);
        if (read !== count) throw new Error('short read during journal tail repair');
        const newline = block.subarray(0, read).lastIndexOf(0x0a);
        if (newline >= 0) {
          length = position + newline + 1;
          break;
        }
      }
      if (length === size) return 0;
      ftruncateSync(fd, length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.fsyncDirectory();
    return 1;
  }

  /** 확인 prefix를 잘라내되 manifest로 두 파일 rename 사이의 크래시 창을 복구한다. */
  private compact(): void {
    closeSync(this.fd);
    this.closed = true;

    const lines = this.pending.map(
      (entry) => `${JSON.stringify(entry.event)}\n`,
    );
    writeFileSync(this.compactPath, lines.join(''));
    const tmpFd = openSync(this.compactPath, 'r+');
    try {
      fsyncSync(tmpFd);
    } finally {
      closeSync(tmpFd);
    }

    const nextState: CheckpointState = {
      offset: 0,
      journalBaseCount:
        this.journalBaseCount + this.confirmedSinceCompaction,
      confirmedSinceCompaction: 0,
    };
    this.writeAtomicJson(this.compactManifestPath, {
      checkpoint: nextState,
    } satisfies CompactionManifest);
    renameSync(this.compactPath, this.journalPath);
    this.fsyncDirectory();
    this.persistCheckpoint(nextState);
    unlinkSync(this.compactManifestPath);
    this.fsyncDirectory();

    this.checkpointOffset = 0;
    this.journalBaseCount = nextState.journalBaseCount;
    this.confirmedSinceCompaction = 0;
    this.journalEntryCount = this.pending.length;
    this.pending = this.pending.map((entry, index) => ({
      event: entry.event,
      bytes: Buffer.byteLength(lines[index], 'utf8'),
      eventBytes: Buffer.byteLength(JSON.stringify(entry.event), 'utf8'),
    }));
    this.fd = openSync(this.journalPath, 'a');
    this.closed = false;
  }

  /** SIGKILL로 중단된 컴팩션을 새 journal + offset 0 상태로 끝낸다. */
  private recoverCompaction(): void {
    if (!existsSync(this.compactManifestPath)) {
      if (existsSync(this.compactPath)) unlinkSync(this.compactPath);
      return;
    }
    let manifest: CompactionManifest;
    try {
      manifest = JSON.parse(
        readFileSync(this.compactManifestPath, 'utf8'),
      ) as CompactionManifest;
      if (!isCheckpointState(manifest.checkpoint)) {
        throw new Error('invalid compaction manifest');
      }
    } catch {
      throw new Error('cannot recover outbox compaction manifest');
    }
    if (existsSync(this.compactPath)) {
      renameSync(this.compactPath, this.journalPath);
      this.fsyncDirectory();
    }
    this.persistCheckpoint(manifest.checkpoint);
    unlinkSync(this.compactManifestPath);
    this.fsyncDirectory();
  }

  private writeAtomicJson(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    this.fsyncDirectory();
  }

  private fsyncDirectory(): void {
    const fd = openSync(this.dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

function writeAll(fd: number, value: string): void {
  const buffer = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('failed to append outbox journal');
    offset += written;
  }
}

function statSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function isCheckpointState(value: unknown): value is CheckpointState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    nonNegativeInteger(state.offset) !== undefined &&
    nonNegativeInteger(state.journalBaseCount) !== undefined &&
    nonNegativeInteger(state.confirmedSinceCompaction) !== undefined
  );
}

function isEventRecord(value: unknown): value is EventInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'event_id' in value &&
    typeof value.event_id === 'string'
  );
}
