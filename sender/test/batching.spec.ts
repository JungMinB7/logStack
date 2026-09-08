import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventInput } from '../../scripts/send-events';
import { batchBodyByteLength } from '../../scripts/send-events';
import {
  BATCH_INTERVAL_MS,
  isBatchReady,
  MAX_BATCH_BYTES,
  MAX_EVENTS_PER_BATCH,
} from '../src/daemon';
import { Outbox } from '../src/outbox';

function makeEvent(i: number, payload: Record<string, unknown> = {}): EventInput {
  return {
    instance_id: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
    event_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    event_type: 'monster_kill',
    user_id: 1001,
    character_id: 10011,
    session_id: 's-1',
    channel_id: 'channel-01',
    payload,
    occurred_at: '2049-06-01T00:00:00.000Z',
  };
}

describe('배칭 조건 3종 — 1초 / 500건 / 3MB 선도달 (design.md §4.1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sender-batch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('500건 상한: peekBatch는 최대 500건까지만 자른다 → 즉시 전송 대상', () => {
    const outbox = Outbox.open(dir);
    outbox.appendMany(
      Array.from({ length: 501 }, (_, i) => makeEvent(i)),
    );
    const batch = outbox.peekBatch(MAX_EVENTS_PER_BATCH, MAX_BATCH_BYTES);
    expect(batch).toHaveLength(500);
    // 건수 상한 도달 → 1초를 기다리지 않고 전송
    expect(isBatchReady(batch.length, 500, outbox.pendingCount, Date.now(), Date.now())).toBe(true);
    outbox.close();
  });

  it('3MB 상한: 직렬화 크기가 넘으면 앞에서 잘리고, 잘린 배치는 즉시 전송 대상', () => {
    const outbox = Outbox.open(dir);
    const big = 'x'.repeat(1_100_000); // 이벤트당 약 1.1MB
    outbox.appendMany([
      makeEvent(1, { blob: big }),
      makeEvent(2, { blob: big }),
      makeEvent(3, { blob: big }),
    ]);
    const batch = outbox.peekBatch(MAX_EVENTS_PER_BATCH, MAX_BATCH_BYTES);
    expect(batch).toHaveLength(2); // 3건째에서 3MB 초과 → 잘림
    expect(batchBodyByteLength(batch)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(
      batchBodyByteLength([...batch, makeEvent(3, { blob: big })]),
    ).toBeGreaterThan(MAX_BATCH_BYTES);
    // 바이트 상한으로 잘려 pending이 더 남음 → 즉시 전송 (full)
    expect(isBatchReady(batch.length, 500, outbox.pendingCount, Date.now(), Date.now())).toBe(true);
    outbox.close();
  });

  it('1초 조건: 상한 미달 배치는 1초 경과 후에만 전송 대상이 된다', () => {
    const now = 1_000_000;
    // 3건뿐(상한 미달) — 마지막 전송 직후에는 대기
    expect(isBatchReady(3, 500, 3, now, now + 500)).toBe(false);
    // 1초 경과 → 전송
    expect(isBatchReady(3, 500, 3, now, now + BATCH_INTERVAL_MS)).toBe(true);
    // 빈 배치는 어떤 경우에도 전송하지 않는다
    expect(isBatchReady(0, 500, 0, now, now + 10_000)).toBe(false);
  });
});
