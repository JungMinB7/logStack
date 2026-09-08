import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventInput } from '../../scripts/send-events';
import type { SenderConfig } from '../src/config';
import {
  MAX_EVENTS_PER_BATCH,
  SenderDaemon,
  type SenderDaemonDependencies,
} from '../src/daemon';

function makeEvent(i: number): EventInput {
  return {
    instance_id: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
    event_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    event_type: 'monster_kill',
    user_id: 1001,
    character_id: 10011,
    session_id: 's-1',
    channel_id: 'channel-01',
    payload: {},
    occurred_at: '2049-06-01T00:00:00.000Z',
  };
}

/** status·본문·헤더를 고정 반환하는 가짜 fetch */
function fakeFetch(
  status: number,
  bodyFor: (requestBody: string) => string,
  headers: Record<string, string> = {},
): typeof fetch {
  return (_url, init?: RequestInit) => {
    const requestBody = typeof init?.body === 'string' ? init.body : '';
    return Promise.resolve(
      new Response(bodyFor(requestBody), { status, headers }),
    );
  };
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected string body');
  return init.body;
}

/** 서버 정상 ACK — 요청의 batch_id·건수를 그대로 반영 (일부 rejected 지정 가능) */
function ackBody(rejectedIndexes: number[] = []) {
  return (requestBody: string): string => {
    const parsed = JSON.parse(requestBody) as {
      batch_id: string;
      events: unknown[];
    };
    const received = parsed.events.length;
    const rejected = rejectedIndexes.map((index) => ({
      index,
      code: 'INVALID_PAYLOAD',
      message: 'shop_purchase.payload: invalid',
    }));
    return JSON.stringify({
      batch_id: parsed.batch_id,
      received_count: received,
      accepted_count: received - rejected.length,
      stored_count: received - rejected.length,
      duplicate_count: 0,
      order_duplicate_count: 0,
      rejected_count: rejected.length,
      rejected,
    });
  };
}

describe('SenderDaemon.sendBatch — §4.2 분기별 체크포인트 전진/정지', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sender-daemon-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDaemon(
    fetchFn: typeof fetch,
    events: EventInput[],
    dependencies: SenderDaemonDependencies = {},
  ): SenderDaemon {
    const config: SenderConfig = {
      instanceId: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
      apiKey: 'test-key',
      targetUrl: 'http://localhost:9',
      users: 0, // 생성기 비활성 — sendBatch만 검증
      eventRate: 0,
      sendRateLimit: 60,
      outboxDir: dir,
    };
    const daemon = new SenderDaemon(config, fetchFn, dependencies);
    daemon.enqueue(events);
    return daemon;
  }

  it('200 확인 → 체크포인트 전진 (pending 감소), rejected는 실패 저널로 격리', async () => {
    const daemon = makeDaemon(
      fakeFetch(200, ackBody([1])),
      [makeEvent(1), makeEvent(2), makeEvent(3)],
    );
    await daemon.sendBatch(daemon.peekBatch());

    expect(daemon.pendingCount).toBe(0); // rejected 포함 전체가 "처리 완료"로 전진
    const failed = readFileSync(join(dir, 'failed.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(failed).toHaveLength(1);
    expect(
      (JSON.parse(failed[0]) as { event: EventInput }).event.event_id,
    ).toBe(makeEvent(2).event_id); // index 1 = 두 번째 이벤트
    daemon.closeOutbox();
  });

  it('401 → 전송 중지(halt), 체크포인트 정지 (outbox 보존)', async () => {
    const daemon = makeDaemon(fakeFetch(401, () => '{}'), [makeEvent(1)]);
    await daemon.sendBatch(daemon.peekBatch());

    expect(daemon.isAuthHalted).toBe(true);
    expect(daemon.pendingCount).toBe(1); // 전진 없음 — 키 교정 후 재개 가능
    daemon.closeOutbox();
  });

  it.each([200, 400, 413])('HTTP %i 격리 fsync 실패 시 ACK가 체크포인트를 전진시키지 않는다', async (status) => {
    const daemon = makeDaemon(fakeFetch(status, ackBody([0])), [makeEvent(1)]);
    const before = readFileSync(join(dir, 'checkpoint.json'), 'utf8');
    const sync = jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('quarantine fsync EIO');
    });
    try {
      await expect(daemon.sendBatch(daemon.peekBatch())).rejects.toThrow('quarantine fsync EIO');
      expect(daemon.pendingCount).toBe(1);
      expect(readFileSync(join(dir, 'checkpoint.json'), 'utf8')).toBe(before);
    } finally {
      sync.mockRestore();
      daemon.closeOutbox();
    }
  });

  it('400 → 배치 전체 격리 + 체크포인트 전진 (재전송 안 함)', async () => {
    const daemon = makeDaemon(fakeFetch(400, () => '{}'), [
      makeEvent(1),
      makeEvent(2),
    ]);
    await daemon.sendBatch(daemon.peekBatch());

    expect(daemon.pendingCount).toBe(0);
    const failed = readFileSync(join(dir, 'failed.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(failed).toHaveLength(2);
    daemon.closeOutbox();
  });

  it('413 → 배치 상한 이분할, 체크포인트 정지 (같은 이벤트 재전송 예정)', async () => {
    const daemon = makeDaemon(
      fakeFetch(413, () => '{}'),
      Array.from({ length: 10 }, (_, i) => makeEvent(i)),
    );
    await daemon.sendBatch(daemon.peekBatch());

    expect(daemon.currentBatchCap).toBe(5); // 10 → 5
    expect(daemon.pendingCount).toBe(10); // 전진 없음
    expect(daemon.peekBatch()).toHaveLength(5); // 다음 전송은 절반 크기
    daemon.closeOutbox();
  });

  it('413 두 절반을 모두 처리할 때까지 split cap을 유지한다', async () => {
    let calls = 0;
    const fetchFn = fakeFetch(200, (requestBody) => {
      calls += 1;
      if (calls === 1) return '{}';
      return ackBody()(requestBody);
    });
    // 첫 호출만 413이 되도록 Response status를 동적으로 만들어야 하므로 wrapper 사용
    const dynamicFetch: typeof fetch = async (url, init) => {
      if (calls === 0) {
        calls += 1;
        return new Response('{}', { status: 413 });
      }
      return fetchFn(url, init);
    };
    const daemon = makeDaemon(
      dynamicFetch,
      Array.from({ length: 10 }, (_, index) => makeEvent(index)),
    );

    await daemon.sendBatch(daemon.peekBatch());
    expect(daemon.currentBatchCap).toBe(5);
    await daemon.sendBatch(daemon.peekBatch());
    expect(daemon.pendingCount).toBe(5);
    expect(daemon.currentBatchCap).toBe(5);
    await daemon.sendBatch(daemon.peekBatch());
    expect(daemon.pendingCount).toBe(0);
    expect(daemon.currentBatchCap).toBe(MAX_EVENTS_PER_BATCH);
    daemon.closeOutbox();
  });

  it('503 → 지수 백오프 후 재전송 대기, 체크포인트 정지', async () => {
    const daemon = makeDaemon(fakeFetch(503, () => '{}'), [makeEvent(1)]);
    const startedAt = Date.now();
    await daemon.sendBatch(daemon.peekBatch());

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900); // 1차 백오프 ≈ 1초
    expect(daemon.pendingCount).toBe(1); // 같은 event_id 그대로 남음 (at-least-once)
    expect(existsSync(join(dir, 'failed.jsonl'))).toBe(false); // 격리 아님
    daemon.closeOutbox();
  });

  it('200 + batch_id 불일치 → 체크포인트 정지 (전체 재전송 대기)', async () => {
    const daemon = makeDaemon(
      fakeFetch(200, () => ackBody()( // 다른 batch_id로 응답
        JSON.stringify({ batch_id: 'another-id', events: [1] }),
      )),
      [makeEvent(1)],
    );
    await daemon.sendBatch(daemon.peekBatch());

    expect(daemon.pendingCount).toBe(1);
    daemon.closeOutbox();
  });

  it.each([
    ['파싱 실패', () => 'null'],
    [
      'received_count 축소',
      () =>
        JSON.stringify({
          batch_id: 'patched below',
          received_count: 0,
          accepted_count: 0,
          stored_count: 0,
          duplicate_count: 0,
          order_duplicate_count: 0,
          rejected_count: 0,
          rejected: [],
        }),
    ],
  ])('200 %s → 체크포인트 정지', async (_label, bodyFactory) => {
    const fetchFn: typeof fetch = (_url, init) => {
      const request = JSON.parse(requestBody(init)) as { batch_id: string };
      const raw = bodyFactory();
      const body = raw.replace('patched below', request.batch_id);
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const daemon = makeDaemon(fetchFn, [makeEvent(1)]);
    await daemon.sendBatch(daemon.peekBatch());
    expect(daemon.pendingCount).toBe(1);
    expect(existsSync(join(dir, 'failed.jsonl'))).toBe(false);
    daemon.closeOutbox();
  });

  it('200 + rejected index 오류 → 격리도 checkpoint 전진도 하지 않는다', async () => {
    const fetchFn: typeof fetch = (_url, init) => {
      const request = JSON.parse(requestBody(init)) as { batch_id: string };
      return Promise.resolve(
        new Response(
          JSON.stringify({
          batch_id: request.batch_id,
          received_count: 1,
          accepted_count: 0,
          stored_count: 0,
          duplicate_count: 0,
          order_duplicate_count: 0,
          rejected_count: 1,
          rejected: [{ index: 99, code: 'BAD', message: 'bad' }],
          }),
          { status: 200 },
        ),
      );
    };
    const daemon = makeDaemon(fetchFn, [makeEvent(1)]);
    await daemon.sendBatch(daemon.peekBatch());
    expect(daemon.pendingCount).toBe(1);
    expect(existsSync(join(dir, 'failed.jsonl'))).toBe(false);
    daemon.closeOutbox();
  });

  it('403도 401과 동일하게 전송 중지 + outbox 보존', async () => {
    const daemon = makeDaemon(fakeFetch(403, () => '{}'), [makeEvent(1)]);
    await daemon.sendBatch(daemon.peekBatch());
    expect(daemon.isAuthHalted).toBe(true);
    expect(daemon.pendingCount).toBe(1);
    daemon.closeOutbox();
  });

  it('429는 Retry-After+jitter 대기 후 checkpoint를 유지한다', async () => {
    const waits: number[] = [];
    const daemon = makeDaemon(
      fakeFetch(429, () => '{}', { 'retry-after': '7' }),
      [makeEvent(1)],
      {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        random: () => 0.25,
      },
    );
    await daemon.sendBatch(daemon.peekBatch());
    expect(waits).toEqual([7_250]);
    expect(daemon.pendingCount).toBe(1);
    daemon.closeOutbox();
  });

  it('네트워크 오류는 같은 이벤트를 보존하고 지수 백오프한다', async () => {
    const waits: number[] = [];
    const fetchFn: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const daemon = makeDaemon(fetchFn, [makeEvent(1)], {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await daemon.sendBatch(daemon.peekBatch());
    await daemon.sendBatch(daemon.peekBatch());
    expect(waits).toEqual([1_000, 2_000]);
    expect(daemon.pendingCount).toBe(1);
    expect(daemon.peekBatch()[0].event_id).toBe(makeEvent(1).event_id);
    daemon.closeOutbox();
  });
});
