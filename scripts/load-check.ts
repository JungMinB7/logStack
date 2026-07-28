/**
 * 처리량 실측 스크립트 — 전송 제약의 이론 상한 시나리오를 재현한다.
 *
 * 시나리오 (design.md §2.1·§2.2, assumptions A-4·A-25):
 * - 논리 인스턴스 10개(최소 분포), 인스턴스당 순차 전송(in-flight 1)
 * - 인스턴스당 2 req/s (500ms 간격) → 전체 20 req/s
 * - 배치당 15~150건 (평균 부하 15건/초·인스턴스 ~ 피크 구간 재현)
 * - 기본 2분간 전송 후 요약 출력: 총 요청/이벤트, 성공률, 응답 시간
 *   p50/p95/max, (docker 환경이면) 서버 batch duration_ms 분포
 *
 * 사용: npx ts-node scripts/load-check.ts [--duration-sec 120] [--instances 10]
 *       [--interval-ms 500] [--min-batch 15] [--max-batch 150]
 * 환경변수: BASE_URL, INGEST_API_KEY, INGEST_INSTANCE_ID (기본값은 .env.example과 동일)
 *
 * 주의: 과제 구현은 단일 인스턴스 키이므로(A-8, §5.4) 10개 "논리 전송 루프"가
 * 같은 instance_id로 전송한다. 로컬 docker 기준 측정이며 운영 규모 보장이 아니다.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { BatchResponse, EventInput } from './send-events';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const API_KEY = process.env.INGEST_API_KEY ?? 'dev-ingest-key';
const INSTANCE_ID =
  process.env.INGEST_INSTANCE_ID ?? '0fab3f2e-1894-41cd-b915-f99440a3ff32';

interface Options {
  durationSec: number;
  instances: number;
  intervalMs: number;
  minBatch: number;
  maxBatch: number;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback: number): number => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? Number(argv[index + 1]) : fallback;
  };
  return {
    durationSec: get('duration-sec', 120),
    instances: get('instances', 10),
    intervalMs: get('interval-ms', 500),
    minBatch: get('min-batch', 15),
    maxBatch: get('max-batch', 150),
  };
}

interface RequestResult {
  ok: boolean;
  latencyMs: number;
  events: number;
  stored: number;
  duplicate: number;
  rejected: number;
}

const ACTIVITY_TYPES = [
  'monster_kill',
  'exp_gain',
  'item_acquire',
  'map_enter',
  'quest_complete',
  'boss_clear',
] as const;

function makeEvents(count: number, instanceIndex: number): EventInput[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => {
    // 300 동접 가정: 인스턴스당 30명 (user 풀 고정)
    const userId = 100_000 + instanceIndex * 30 + (i % 30);
    const isPurchase = i % 40 === 39; // 배치당 소수의 결제 이벤트
    return {
      instance_id: INSTANCE_ID,
      event_id: randomUUID(),
      event_type: isPurchase
        ? 'shop_purchase'
        : ACTIVITY_TYPES[i % ACTIVITY_TYPES.length],
      user_id: userId,
      character_id: userId * 10 + 1,
      session_id: `load-s-${instanceIndex}-${userId}`,
      channel_id: `channel-0${1 + (instanceIndex % 3)}`,
      payload: isPurchase
        ? {
            order_id: `ORDER-LOAD-${randomUUID()}`,
            product_id: 'cash-item-load',
            product_name: 'load test item',
            quantity: 1,
            amount_minor: 1000,
            currency: 'KRW',
          }
        : { source: 'load-check' },
      occurred_at: now,
    };
  });
}

async function sendBatch(
  events: EventInput[],
): Promise<RequestResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/v1/event-batches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        batch_id: randomUUID(),
        sent_at: new Date().toISOString(),
        events,
      }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      await res.text();
      return { ok: false, latencyMs, events: events.length, stored: 0, duplicate: 0, rejected: 0 };
    }
    const body = (await res.json()) as BatchResponse;
    return {
      ok: body.rejected_count === 0,
      latencyMs,
      events: events.length,
      stored: body.stored_count,
      duplicate: body.duplicate_count,
      rejected: body.rejected_count,
    };
  } catch {
    return { ok: false, latencyMs: Date.now() - started, events: events.length, stored: 0, duplicate: 0, rejected: 0 };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

/** docker 환경이면 앱 로그의 batch processed duration_ms 분포를 수집 (실패 시 생략) */
function collectServerDurations(sinceIso: string): number[] {
  try {
    const logs = execSync(
      `docker logs rusheight-test-app-1 --since ${sinceIso} 2>&1`,
      { maxBuffer: 64 * 1024 * 1024 },
    ).toString();
    const durations: number[] = [];
    for (const line of logs.split('\n')) {
      const match = line.match(/\{"msg":"batch processed".*\}/);
      if (!match) continue;
      const parsed = JSON.parse(match[0]) as { duration_ms?: number };
      if (typeof parsed.duration_ms === 'number') {
        durations.push(parsed.duration_ms);
      }
    }
    return durations;
  } catch {
    return [];
  }
}

async function instanceLoop(
  instanceIndex: number,
  endAt: number,
  options: Options,
  rng: () => number,
  results: RequestResult[],
): Promise<void> {
  // 순차 전송(in-flight 1) + 고정 간격 — A-25의 전송측 모델 재현
  while (Date.now() < endAt) {
    const tickStart = Date.now();
    const size =
      options.minBatch +
      Math.floor(rng() * (options.maxBatch - options.minBatch + 1));
    results.push(await sendBatch(makeEvents(size, instanceIndex)));
    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, options.intervalMs - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedIso = new Date().toISOString();
  const endAt = Date.now() + options.durationSec * 1000;
  let seed = 42;
  const rng = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  console.log(
    `load-check: ${options.instances} instances × ${1000 / options.intervalMs} req/s, ` +
      `batch ${options.minBatch}~${options.maxBatch} events, ${options.durationSec}s`,
  );

  const results: RequestResult[] = [];
  await Promise.all(
    Array.from({ length: options.instances }, (_, i) =>
      instanceLoop(i, endAt, options, rng, results),
    ),
  );

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalEvents = results.reduce((sum, r) => sum + r.events, 0);
  const totalStored = results.reduce((sum, r) => sum + r.stored, 0);
  const okCount = results.filter((r) => r.ok).length;
  const serverDurations = collectServerDurations(startedIso).sort(
    (a, b) => a - b,
  );

  const summary = {
    duration_sec: options.durationSec,
    requests: results.length,
    achieved_rps: Number((results.length / options.durationSec).toFixed(1)),
    events: totalEvents,
    events_per_sec: Number((totalEvents / options.durationSec).toFixed(0)),
    stored: totalStored,
    success_rate: Number((okCount / Math.max(1, results.length)).toFixed(4)),
    client_latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies[latencies.length - 1] ?? 0,
    },
    server_batch_duration_ms:
      serverDurations.length > 0
        ? {
            samples: serverDurations.length,
            p50: percentile(serverDurations, 50),
            p95: percentile(serverDurations, 95),
            max: serverDurations[serverDurations.length - 1],
          }
        : 'unavailable (docker logs 접근 불가)',
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.success_rate < 1) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
