import { randomUUID } from 'node:crypto';
import {
  batchBodyByteLength,
  MAX_BATCH_BYTES as SHARED_MAX_BATCH_BYTES,
  MAX_EVENTS_PER_BATCH as SHARED_MAX_EVENTS_PER_BATCH,
  serializeBatch,
  type EventInput,
} from '../../scripts/send-events';
import { decideAck } from './ack';
import { backoffDelayMs, rateLimitedDelayMs } from './backoff';
import type { SenderConfig } from './config';
import { EventGenerator } from './generator';
import { log } from './logger';
import { BackpressureLogGate } from './log-gate';
import { Outbox } from './outbox';
import { FixedWindowThrottle } from './throttle';

/** 배칭 상한 — 서버 계약(500건)·3MB 소프트 상한 (design.md §4.1, 서버 하드 4MB보다 낮게) */
export const MAX_EVENTS_PER_BATCH = SHARED_MAX_EVENTS_PER_BATCH;
export const MAX_BATCH_BYTES = SHARED_MAX_BATCH_BYTES;
/** 배칭 주기 — 1초 경과 시 상한 미달이어도 전송 (design.md §4.1) */
export const BATCH_INTERVAL_MS = 1_000;
/** 전송측 요청 timeout 30초 (과제 제약) */
const REQUEST_TIMEOUT_MS = 30_000;
/** 이벤트 생성 틱 주기 */
const GENERATE_TICK_MS = 200;
/** outbox 적체 상한 — 초과 시 생성 중단(게임 로직 backpressure 대체) [A-26] */
const BACKPRESSURE_PENDING_LIMIT = 100_000;
/** 관측 로그 주기 */
const STATS_INTERVAL_MS = 5_000;

/**
 * 배치 전송 시점 판정 (순수 함수 — 단위 테스트 대상).
 * 1초 경과 / 건수 상한(cap) / 3MB 상한(바이트로 잘려 pending이 더 남은 경우) 중
 * 하나가 만족되면 전송한다 (design.md §4.1 — 선도달 조건).
 */
export function isBatchReady(
  batchLength: number,
  batchCap: number,
  pendingCount: number,
  batchStartedAt: number,
  now: number,
): boolean {
  if (batchLength === 0) return false;
  const full = batchLength >= batchCap || pendingCount > batchLength;
  return full || now - batchStartedAt >= BATCH_INTERVAL_MS;
}

interface DaemonStats {
  generation_attempted: number;
  generated: number;
  send_attempts: number;
  sent_batches: number;
  stored: number;
  duplicate: number;
  order_duplicate: number;
  quarantined: number;
  retries: number;
  rate_limited_waits: number;
  max_pending: number;
}

export interface SenderDaemonDependencies {
  /** 단위 테스트에서 실제 대기 없이 delay 계산과 분기를 검증 */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Independent integration observer, invoked only after append+fsync succeeded. */
  onRecorded?: (events: readonly EventInput[]) => void;
}

/**
 * 전송 데몬 — design.md §4(outbox·배칭·순차 전송·§4.2 ACK 표)를 코드로 옮긴 것.
 * in-flight 1 순차 전송 [A-25]: 단일 async 루프에서 await로 자연 보장된다.
 */
export class SenderDaemon {
  private readonly outbox: Outbox;
  private readonly generator: EventGenerator;
  private readonly throttle: FixedWindowThrottle;
  private shuttingDown = false;
  private authHalted = false;
  /** 현재 head batch의 1초 flush 창 시작. 재기동 잔량은 0으로 두어 즉시 drain. */
  private batchStartedAt?: number;
  /** 413으로 쪼갠 head segment 크기. 두 절반이 모두 처리될 때까지 유지한다. */
  private readonly splitSegments: number[] = [];
  private attempt = 0;
  private generateTimer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;
  private readonly backpressureLogs = new BackpressureLogGate();
  private loopPromise?: Promise<void>;
  private readonly startupBacklog: number;
  private startupDrainRemaining: number;
  private startupDrainStartedAt = 0;
  private readonly startupDrainBatchCounts: number[] = [];
  private readonly stats: DaemonStats = {
    generation_attempted: 0,
    generated: 0,
    send_attempts: 0,
    sent_batches: 0,
    stored: 0,
    duplicate: 0,
    order_duplicate: 0,
    quarantined: 0,
    retries: 0,
    rate_limited_waits: 0,
    max_pending: 0,
  };

  constructor(
    private readonly config: SenderConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly dependencies: SenderDaemonDependencies = {},
  ) {
    this.outbox = Outbox.open(config.outboxDir);
    this.generator = new EventGenerator(config);
    this.throttle = new FixedWindowThrottle(config.sendRateLimit);
    this.startupBacklog = this.outbox.pendingCount;
    this.startupDrainRemaining = this.startupBacklog;
    this.stats.max_pending = this.startupBacklog;
    if (this.startupBacklog > 0) this.batchStartedAt = 0;
  }

  start(): void {
    this.startupDrainStartedAt = Date.now();
    log('info', 'sender started', {
      instance_id: this.config.instanceId,
      target: this.config.targetUrl,
      users: this.config.users,
      event_rate: this.config.eventRate,
      send_rate_limit: this.config.sendRateLimit,
      outbox_pending: this.outbox.pendingCount, // 재시작 시 이어서 전송할 잔량 (drain)
      outbox_truncated_lines: this.outbox.truncatedLines,
    });
    if (this.startupBacklog > 0) {
      log('info', 'startup drain started', {
        backlog: this.startupBacklog,
      });
    }

    if (this.config.users > 0 && this.config.eventRate > 0) {
      this.generateTimer = setInterval(() => this.generateTick(), GENERATE_TICK_MS);
    }
    this.statsTimer = setInterval(() => this.logStats(), STATS_INTERVAL_MS);
    this.loopPromise = this.sendLoop();
  }

  /** SIGTERM: 생성 중단 → 진행 중 배치의 응답 처리까지 마치고 반환 (systemd 전제) */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.generateTimer) clearInterval(this.generateTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    log('info', 'generation stopped', {
      generation_attempted: this.stats.generation_attempted,
      recorded: this.stats.generated,
      unrecorded: this.stats.generation_attempted - this.stats.generated,
    });
    await this.loopPromise;
    this.logStats();
    this.outbox.close();
    log('info', 'sender stopped', { outbox_pending: this.outbox.pendingCount });
  }

  // ── 생성 (구성 요소 1·2) ──────────────────────────────────

  private generateTick(): void {
    if (this.outbox.pendingCount >= BACKPRESSURE_PENDING_LIMIT) {
      // outbox 용량 초과 시 이벤트를 버리지 않고 생성을 멈춘다 [A-26].
      // 경고는 초당 1회로 스로틀 — 200ms 틱마다 찍으면 CloudWatch 소음이 된다
      if (this.backpressureLogs.shouldLog('pending_limit')) {
        log('warn', 'backpressure: generation paused', {
          reason: 'pending_limit',
          pending: this.outbox.pendingCount,
        });
      }
      return;
    }
    const events = this.generator.tick(GENERATE_TICK_MS);
    if (events.length === 0) return;
    const wasEmpty = this.outbox.pendingCount === 0;
    this.stats.generation_attempted += events.length;
    this.outbox.appendMany(events); // append + fsync 후에야 기록 성공
    this.dependencies.onRecorded?.(events);
    if (wasEmpty) this.batchStartedAt = Date.now();
    this.stats.generated += events.length;
    this.updateMaxPending();
  }

  // ── 전송 루프 (구성 요소 3~6) ─────────────────────────────

  private async sendLoop(): Promise<void> {
    while (!this.shuttingDown) {
      if (this.authHalted) {
        // 키 문제는 재시도로 해결 불가 — outbox 보존, 전송만 중지 (§4.2)
        await this.sleep(1_000);
        continue;
      }

      const batchCap = this.currentBatchCap;
      const batch = this.outbox.peekBatch(batchCap, MAX_BATCH_BYTES);
      if (batch.length === 0) {
        this.batchStartedAt = undefined;
        await this.sleep(50);
        continue;
      }
      this.batchStartedAt ??= Date.now();

      // 1초 / 500건(현재 cap) / 3MB 선도달 (design.md §4.1).
      // 상한 도달 배치는 1초를 기다리지 않는다 — 시작 시 잔량 drain이 이 경로로
      // 최대 배치를 스로틀 한도 내 최단 소화한다 (plan-aws T3 완료 조건)
      if (
        !isBatchReady(
          batch.length,
          batchCap,
          this.outbox.pendingCount,
          this.batchStartedAt,
          Date.now(),
        )
      ) {
        await this.sleep(50);
        continue;
      }

      // 자체 스로틀 (구성 요소 4) — 창 소진 시 다음 창까지 대기
      const throttleWait = this.throttle.tryAcquire();
      if (throttleWait > 0) {
        log('info', 'self throttle: waiting for next window', {
          wait_ms: throttleWait,
          pending: this.outbox.pendingCount,
        });
        await this.sleep(throttleWait);
        continue;
      }

      await this.sendBatch(batch);
    }
  }

  // ── 테스트 관측용 접근자 (상태 변경 없음) ──────────────────
  get pendingCount(): number {
    return this.outbox.pendingCount;
  }
  get isAuthHalted(): boolean {
    return this.authHalted;
  }
  get currentBatchCap(): number {
    return this.splitSegments[0] ?? MAX_EVENTS_PER_BATCH;
  }
  /** 미확인 head 배치를 들여다본다 — 단위 테스트에서 sendBatch 입력을 만들 때 사용 */
  peekBatch(): EventInput[] {
    return this.outbox.peekBatch(this.currentBatchCap, MAX_BATCH_BYTES);
  }
  /** 테스트에서 outbox에 직접 이벤트를 적재할 때 사용 (fsync 포함) */
  enqueue(events: EventInput[]): void {
    const wasEmpty = this.outbox.pendingCount === 0;
    this.outbox.appendMany(events);
    if (wasEmpty && events.length > 0) this.batchStartedAt = Date.now();
    this.updateMaxPending();
  }
  closeOutbox(): void {
    this.outbox.close();
  }

  /**
   * 배치 1회 전송 + §4.2 ACK 처리. 루프에서 호출되며, 단위 테스트가
   * 분기별 체크포인트 전진/정지를 검증하기 위해 직접 호출할 수 있다.
   */
  async sendBatch(batch: EventInput[]): Promise<void> {
    const batchId = randomUUID();
    const bodyJson = serializeBatch(batchId, new Date().toISOString(), batch);
    this.stats.send_attempts += 1;
    log('info', 'batch send started', {
      batch_id: batchId,
      count: batch.length,
      body_bytes: batchBodyByteLength(batch),
      attempt: this.attempt + 1,
      pending: this.outbox.pendingCount,
    });

    let status: number;
    let bodyText: string;
    let retryAfter: string | null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await this.fetchFn(
          `${this.config.targetUrl}/api/v1/event-batches`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.config.apiKey}`,
            },
            body: bodyJson,
            signal: controller.signal,
          },
        );
        status = res.status;
        retryAfter = res.headers.get('retry-after');
        bodyText = await res.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      // timeout·네트워크 오류 → 지수 백오프 후 같은 event_id 재전송 (§4.2)
      this.attempt += 1;
      this.stats.retries += 1;
      const delay = backoffDelayMs(this.attempt - 1);
      log('warn', 'send failed, backing off', {
        batch_id: batchId,
        count: batch.length,
        attempt: this.attempt,
        delay_ms: delay,
        pending: this.outbox.pendingCount,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.sleep(delay);
      return;
    }

    const action = decideAck(status, bodyText, batchId, batch, retryAfter);
    switch (action.kind) {
      case 'confirm': {
        const body = action.response;
        // rejected는 실패 저널로 격리(재전송 안 함), 나머지는 확인 → 체크포인트 전진
        if (body.rejected.length > 0) {
          const rejectedEvents = body.rejected
            .filter((r) => r.index >= 0 && r.index < batch.length)
            .map((r) => batch[r.index]);
          const quarantined = this.outbox.quarantine(rejectedEvents, 'rejected', {
            batch_id: batchId,
            codes: body.rejected.map((r) => r.code),
          });
          this.stats.quarantined += quarantined;
        }
        this.outbox.confirm(batch.length);
        this.advanceSplitSegments(batch.length);
        this.noteStartupDrainProgress(batch.length);
        this.resetBatchWindowAfterProgress();
        this.attempt = 0;
        this.stats.sent_batches += 1;
        this.stats.stored += body.stored_count;
        this.stats.duplicate += body.duplicate_count;
        this.stats.order_duplicate += body.order_duplicate_count;
        log('info', 'batch acked', {
          batch_id: batchId,
          count: batch.length,
          stored: body.stored_count,
          duplicate: body.duplicate_count,
          order_duplicate: body.order_duplicate_count,
          rejected: body.rejected_count,
          pending: this.outbox.pendingCount,
        });
        return;
      }
      case 'resend':
        this.stats.retries += 1;
        log('warn', 'ack unusable, resending whole batch', {
          batch_id: batchId,
          reason: action.reason,
        });
        return; // 다음 루프에서 같은 head 재전송 — 멱등성이 중복 흡수
      case 'halt':
        this.authHalted = true;
        // 운영 알림 대체 — 프로세스는 유지하고 outbox는 계속 보존된다
        log('error', 'auth failed: sending halted (fix key/instance mapping)', {
          status: action.status,
          pending: this.outbox.pendingCount,
        });
        return;
      case 'quarantine_batch':
        this.stats.quarantined += this.outbox.quarantine(
          batch,
          'batch_malformed_400',
          {
            batch_id: batchId,
          },
        );
        this.outbox.confirm(batch.length);
        this.advanceSplitSegments(batch.length);
        this.noteStartupDrainProgress(batch.length);
        this.resetBatchWindowAfterProgress();
        this.attempt = 0;
        log('warn', 'batch quarantined (400)', {
          batch_id: batchId,
          count: batch.length,
        });
        return;
      case 'split':
        if (batch.length === 1) {
          // 더 나눌 수 없는 단일 이벤트가 413 → 격리 (비정상 초대형 payload)
          this.stats.quarantined += this.outbox.quarantine(
            batch,
            'oversized_413',
            { batch_id: batchId },
          );
          this.outbox.confirm(1);
          this.advanceSplitSegments(1);
          this.noteStartupDrainProgress(1);
          this.resetBatchWindowAfterProgress();
          this.attempt = 0;
          return;
        }
        this.splitCurrentBatch(batch.length);
        log('warn', 'payload too large, splitting batch', {
          batch_id: batchId,
          count: batch.length,
          next_cap: this.currentBatchCap,
        });
        return; // 다음 루프에서 절반 크기로 재전송
      case 'rate_limited': {
        const delay = rateLimitedDelayMs(
          action.retryAfterSec,
          this.dependencies.random,
        );
        this.stats.rate_limited_waits += 1;
        log('warn', 'rate limited by server, waiting retry-after + jitter', {
          batch_id: batchId,
          retry_after_s: action.retryAfterSec,
          wait_ms: delay,
          pending: this.outbox.pendingCount,
        });
        await this.sleep(delay);
        return;
      }
      case 'backoff': {
        this.attempt += 1;
        this.stats.retries += 1;
        const delay = backoffDelayMs(this.attempt - 1);
        log('warn', 'server error, backing off', {
          batch_id: batchId,
          status: action.status,
          attempt: this.attempt,
          delay_ms: delay,
          pending: this.outbox.pendingCount,
        });
        await this.sleep(delay);
        return;
      }
    }
  }

  /** 현재 head segment를 두 절반으로 대체한다. 기존 상위 segment의 나머지도 보존. */
  private splitCurrentBatch(batchLength: number): void {
    const currentSegment = this.splitSegments.shift() ?? batchLength;
    const segmentRemainder = Math.max(0, currentSegment - batchLength);
    const left = Math.ceil(batchLength / 2);
    const right = batchLength - left;
    const replacement = [left, right, segmentRemainder].filter(
      (size) => size > 0,
    );
    this.splitSegments.unshift(...replacement);
  }

  /** 확인/격리된 head 수만큼 413 segment 계획을 전진시킨다. */
  private advanceSplitSegments(count: number): void {
    let remaining = count;
    while (remaining > 0 && this.splitSegments.length > 0) {
      const current = this.splitSegments[0];
      if (remaining < current) {
        this.splitSegments[0] = current - remaining;
        return;
      }
      remaining -= current;
      this.splitSegments.shift();
    }
  }

  private noteStartupDrainProgress(count: number): void {
    if (this.startupDrainRemaining <= 0) return;
    const drained = Math.min(count, this.startupDrainRemaining);
    this.startupDrainRemaining -= drained;
    this.startupDrainBatchCounts.push(drained);
    if (this.startupDrainRemaining === 0) {
      log('info', 'startup drain completed', {
        backlog: this.startupBacklog,
        batches: this.startupDrainBatchCounts.length,
        batch_counts: this.startupDrainBatchCounts,
        duration_ms: Date.now() - this.startupDrainStartedAt,
        pending: this.outbox.pendingCount,
      });
    }
  }

  private updateMaxPending(): void {
    this.stats.max_pending = Math.max(
      this.stats.max_pending,
      this.outbox.pendingCount,
    );
  }

  private resetBatchWindowAfterProgress(): void {
    if (this.outbox.pendingCount === 0) {
      this.batchStartedAt = undefined;
    } else if (this.startupDrainRemaining > 0) {
      this.batchStartedAt = 0;
    } else {
      this.batchStartedAt = Date.now();
    }
  }

  // ── 관측 (구성 요소 8) ────────────────────────────────────

  private logStats(): void {
    log('info', 'stats', {
      ...this.stats,
      pending: this.outbox.pendingCount, // 적체량
      pending_bytes: this.outbox.pendingBytes,
      recorded: this.outbox.recordedCount,
      failed: this.outbox.failedCount,
      startup_drain_remaining: this.startupDrainRemaining,
      auth_halted: this.authHalted,
    });
  }

  /** 종료 신호에 반응하는 대기 — 250ms 단위로 쪼개 shutdown을 확인한다 */
  private async sleep(ms: number): Promise<void> {
    if (this.dependencies.sleep) {
      await this.dependencies.sleep(ms);
      return;
    }
    const deadline = Date.now() + ms;
    while (!this.shuttingDown && Date.now() < deadline) {
      const chunk = Math.min(250, deadline - Date.now());
      await new Promise((resolve) => setTimeout(resolve, chunk));
    }
  }
}
