/**
 * 고정 데이터셋 seed — 적재 API 경유로 투입한다.
 *
 * DB 직접 INSERT를 쓰지 않는 이유: seed 자체가 적재 경로(인증·검증·멱등성
 * 트랜잭션)의 동작 검증을 겸하기 위해서다 (design.md §12.1).
 *
 * 전제: 서버 실행 중 (docker compose up -d 또는 npm run start:dev)
 * 환경변수: BASE_URL (기본 http://localhost:3000), INGEST_API_KEY (기본 dev-ingest-key)
 *
 * 실행: npm run seed
 */
import { sendEvents } from './send-events';
import {
  DETERMINISTIC_EVENTS,
  EXPECTED_INGEST,
} from '../test/fixtures/deterministic-events';

async function main(): Promise<void> {
  console.log(
    `seeding ${DETERMINISTIC_EVENTS.length} fixture events via ingestion API...`,
  );
  const result = await sendEvents(DETERMINISTIC_EVENTS);
  console.log(JSON.stringify(result, null, 2));

  if (result.rejected > 0) {
    console.error('seed FAILED: some events were rejected');
    process.exit(1);
  }

  const total = EXPECTED_INGEST.stored + EXPECTED_INGEST.duplicate;
  if (
    result.stored === EXPECTED_INGEST.stored &&
    result.duplicate === EXPECTED_INGEST.duplicate
  ) {
    console.log(
      `seed OK: 첫 적재 기대값 일치 (stored ${result.stored} / duplicate ${result.duplicate} — 같은 event_id 2회 전송분이 중복 제거됨)`,
    );
  } else if (result.stored === 0 && result.duplicate === total) {
    console.log(
      'seed OK: 이미 적재된 데이터 — 전량 duplicate (event_id 멱등성 확인, 행 수 불변)',
    );
  } else {
    console.warn(
      `seed WARN: 부분 적재 상태 (stored ${result.stored} / duplicate ${result.duplicate}) — 기존 데이터와 섞였을 수 있음`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  console.error('서버가 실행 중인지 확인하세요: docker compose up -d');
  process.exit(1);
});
