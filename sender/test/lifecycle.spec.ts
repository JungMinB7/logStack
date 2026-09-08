import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventInput } from '../../scripts/send-events';
import type { SenderConfig } from '../src/config';
import { SenderDaemon } from '../src/daemon';

function makeEvent(index: number): EventInput {
  return {
    instance_id: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
    event_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    event_type: 'monster_kill',
    user_id: 1001,
    character_id: 10011,
    session_id: 's-1',
    channel_id: 'channel-01',
    payload: {},
    occurred_at: '2049-06-01T00:00:00.000Z',
  };
}

function config(dir: string): SenderConfig {
  return {
    instanceId: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
    apiKey: 'test-key',
    targetUrl: 'http://localhost:9',
    users: 0,
    eventRate: 0,
    sendRateLimit: 60,
    outboxDir: dir,
  };
}

function ackResponse(requestBody: string): Response {
  const request = JSON.parse(requestBody) as {
    batch_id: string;
    events: EventInput[];
  };
  const count = request.events.length;
  return new Response(
    JSON.stringify({
      batch_id: request.batch_id,
      received_count: count,
      accepted_count: count,
      stored_count: count,
      duplicate_count: 0,
      order_duplicate_count: 0,
      rejected_count: 0,
      rejected: [],
    }),
    { status: 200 },
  );
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected string body');
  return init.body;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('SenderDaemon lifecycle — batching/in-flight/SIGTERM', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sender-lifecycle-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('신규 partial batch는 최초 1초 창 전에 즉시 전송하지 않는다', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = (_url, init) => {
      calls += 1;
      return Promise.resolve(ackResponse(requestBody(init)));
    };
    const daemon = new SenderDaemon(config(dir), fetchFn);
    daemon.enqueue([makeEvent(1)]);
    daemon.start();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(0);
    await waitFor(() => calls === 1, 1_500);
    await waitFor(() => daemon.pendingCount === 0);
    await daemon.stop();
  });

  it('in-flight는 항상 1이고 SIGTERM은 진행 중 응답 처리 후 종료한다', async () => {
    const resolvers: Array<() => void> = [];
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const fetchFn: typeof fetch = async (_url, init) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
      return ackResponse(requestBody(init));
    };
    const daemon = new SenderDaemon(config(dir), fetchFn);
    daemon.enqueue(Array.from({ length: 1_000 }, (_, index) => makeEvent(index)));
    daemon.start();

    await waitFor(() => calls === 1);
    expect(maxActive).toBe(1);
    resolvers.shift()?.();
    await waitFor(() => calls === 2);
    expect(maxActive).toBe(1);

    let stopped = false;
    const stopping = daemon.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    resolvers.shift()?.();
    await stopping;

    expect(maxActive).toBe(1);
    expect(daemon.pendingCount).toBe(0);
  });
});
