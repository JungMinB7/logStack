/**
 * 데모 스크립트 — 고정 데이터셋을 적재(seed)한 뒤 지표 API를 차례로 호출해
 * design.md §12.1의 기대값과 대조해 PASS/FAIL을 출력한다.
 *
 * 전제: 서버 실행 중 (docker compose up -d)
 * 환경변수: BASE_URL, INGEST_API_KEY, ADMIN_API_KEY (기본값은 .env.example과 동일)
 *
 * 실행: npm run demo
 * 종료 코드: 모든 대조 성공 0 / 실패 있음 1
 * (지표 API가 아직 구현되지 않았다면 해당 항목은 FAIL(HTTP 404)로 표시된다)
 */
import { sendEvents } from './send-events';
import {
  DETERMINISTIC_EVENTS,
  EXPECTED_CONVERSION,
  EXPECTED_DAU,
  EXPECTED_ENGAGEMENT_BOSS_CLEAR,
  EXPECTED_RETENTION,
  EXPECTED_REVENUE,
  FIXTURE_RANGE,
} from '../test/fixtures/deterministic-events';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'dev-admin-key';

let failures = 0;

function report(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** expected의 모든 키(재귀)가 actual에 같은 값으로 존재하는지 (배열은 길이·순서 일치) */
function isSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, i) => isSubset(actual[i], item));
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) return false;
    return Object.entries(expected).every(([key, value]) =>
      isSubset((actual as Record<string, unknown>)[key], value),
    );
  }
  return actual === expected;
}

async function checkMetric(
  name: string,
  path: string,
  expected: unknown,
): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
  });
  if (!res.ok) {
    report(name, false, `HTTP ${res.status} (지표 API 미구현이면 404)`);
    return;
  }
  const body: unknown = await res.json();
  if (isSubset(body, expected)) {
    report(name, true);
  } else {
    report(
      name,
      false,
      `기대값 불일치\n  expected ⊆ ${JSON.stringify(expected)}\n  actual     ${JSON.stringify(body)}`,
    );
  }
}

async function main(): Promise<void> {
  // 1) seed — 적재 API 경유 (멱등적이라 재실행해도 안전)
  console.log('── 1. 고정 데이터셋 적재 (design.md §12.1) ──');
  const seedResult = await sendEvents(DETERMINISTIC_EVENTS);
  console.log(
    `ingest: received ${seedResult.received} / stored ${seedResult.stored} / ` +
      `duplicate ${seedResult.duplicate} / rejected ${seedResult.rejected}`,
  );
  report('적재 카운트 불변식 + rejected 없음', seedResult.rejected === 0);

  // 2) 지표 대조
  console.log('\n── 2. 지표 API 기대값 대조 ──');
  const { start, end } = FIXTURE_RANGE;
  await checkMetric(
    `DAU (${start}~${end})`,
    `/api/v1/metrics/dau?start=${start}&end=${end}`,
    EXPECTED_DAU,
  );
  await checkMetric(
    `매출/ARPU (${start}~${end}, KRW)`,
    `/api/v1/metrics/revenue?start=${start}&end=${end}&currency=KRW`,
    EXPECTED_REVENUE,
  );
  await checkMetric(
    `결제 전환율 (${start}~${end})`,
    `/api/v1/metrics/purchase-conversion?start=${start}&end=${end}`,
    EXPECTED_CONVERSION,
  );
  await checkMetric(
    `리텐션 (코호트 ${start}~${end})`,
    `/api/v1/metrics/retention?start=${start}&end=${end}`,
    EXPECTED_RETENTION,
  );
  await checkMetric(
    '참여율 (2026-01-01, boss_clear)',
    `/api/v1/metrics/engagement?start=2026-01-01&end=2026-01-01&event_type=boss_clear`,
    EXPECTED_ENGAGEMENT_BOSS_CLEAR,
  );

  console.log(
    `\n결과: ${failures === 0 ? '모든 항목 PASS' : `FAIL ${failures}건`}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  console.error('서버가 실행 중인지 확인하세요: docker compose up -d');
  process.exit(1);
});
