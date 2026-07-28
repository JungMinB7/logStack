# RPG 게임 로그 적재 파이프라인 & 집계 API

제약이 있는 HTTP 전송 환경(120회/분, 요청 본문 4MB, timeout 30초)에서 게임 이벤트를
유실 없이 적재하고, 운영 지표를 조회하는 서버.

- 설계 문서: [docs/design.md](docs/design.md) (문제 1 제출물)
- API 계약: [docs/api.openapi.yaml](docs/api.openapi.yaml)
- 가정: [docs/assumptions.md](docs/assumptions.md) / 설계 결정: [docs/decisions.md](docs/decisions.md)

> **작성 중 초안** — 적재 API까지 구현된 시점의 README다.
> 지표(집계) API 구현 후 호출 예시·EXPLAIN 결과가 추가된다.

## 실행 방법

```bash
cp .env.example .env          # 환경변수 (기본값으로 바로 동작)
docker compose up -d --build  # PostgreSQL 16 + 앱 (마이그레이션 자동 적용)
curl http://localhost:3000/health   # {"status":"ok"} 확인
```

로컬 개발(핫 리로드)은 `docker compose up -d db` 후 `npm install && npm run start:dev`.

필수 환경변수(`INGEST_API_KEY`, `INGEST_INSTANCE_ID`, `ADMIN_API_KEY`)가 없으면
서버는 부팅에 실패한다(fail-closed). `.env.example`의 기본값을 그대로 쓰면 된다.

## 샘플 데이터 생성·적재·검증

### 1) 고정 데이터셋 (정답을 손으로 계산 가능 — design.md §12.1)

`test/fixtures/deterministic-events.ts`에 event_id까지 고정된 12건의 이벤트가 정의되어
있다. **유저1의 1/1 결제(10,000원)는 같은 event_id로 2회 등장**해 중복 제거 동작을
증명한다. 각 지표의 기대값도 같은 파일에 상수로 정의되어 있다.

| 일자 (UTC) | 이벤트 | 기대 결과 |
|---|---|---|
| 2026-01-01 | 유저1·2 로그인, 유저1 결제 10,000원(같은 event_id 2회), 유저1 boss_clear | DAU 2, 매출 10000, ARPU 5000.00, 전환율 0.5, boss_clear 참여율 0.5 |
| 2026-01-02 | 유저1·2·3 로그인, 유저2 결제 5,000원 | DAU 3, 매출 5000, 전환율 0.3333 |
| 2026-01-08 | 유저1·2 로그인 | 01-01 코호트 D7 = 1.0 |
| 2026-01-31 | 유저1 로그인 | 01-01 코호트 D30 = 0.5 |

기간(01-01~01-02) summary 기대값: unique_users 3, revenue 15000, arpu 5000.00, conversion 0.6667.

**적재 (seed)** — DB에 직접 INSERT하지 않고 적재 API를 경유한다
(seed 자체가 인증·검증·멱등성 트랜잭션의 검증을 겸한다):

```bash
npm run seed
# 첫 실행:  stored 11 / duplicate 1  ← 같은 event_id 2회 전송분이 중복 제거됨
# 재실행:   stored 0  / duplicate 12 ← 전량 duplicate, 행 수 불변 (멱등성)
```

**검증 (demo)** — seed 후 지표 API를 차례로 호출해 기대값과 대조한다:

```bash
npm run demo
# 각 지표별 PASS/FAIL 출력, 실패가 있으면 종료 코드 1
# (지표 API 구현 전에는 해당 항목이 FAIL(HTTP 404)로 표시된다)
```

> demo의 기대값은 "고정 데이터셋만 적재된 상태" 기준이다. E2E 실행(`npm run
> test:e2e`)이나 생성기 데이터가 남아 있으면 아래로 초기화 후 다시 seed한다:
>
> ```bash
> docker exec rusheight-test-db-1 psql -U app -d gamelogs -c "TRUNCATE purchases, game_events"
> npm run seed
> ```

### 2) 임의 데이터 생성기 (부하·시나리오 재현용)

```bash
# 10명 × 3일, 중복 5%, 시간순 뒤섞기, 시드 고정(재현 가능)
npx ts-node scripts/generate-events.ts \
  --users 10 --days 3 --start 2026-02-01 \
  --duplicates 0.05 --shuffle --seed 42 --out events.json

# 500건/3MB 상한으로 배치를 나눠 적재 API에 전송
npx ts-node scripts/send-events.ts events.json
```

- `--duplicates`: 일부 이벤트를 같은 event_id로 재등장시켜 재전송 중복을 재현
- `--shuffle`: "이벤트는 시간순으로 도착하지 않는다" 제약을 재현
- 전송 결과에서 `stored + duplicate = accepted` 불변식을 클라이언트도 검증한다

### 전송측 유의사항

- **`occurred_at`은 시간대 지정자가 필수다** (`Z` 또는 `±hh:mm`).
  `"2026-01-01T10:00:00"`처럼 오프셋 없는 ISO8601 문자열은 적재 시
  `rejected`(INVALID_ENVELOPE) 처리된다. 고정 데이터셋과 생성기는 모두
  `Z` 포함 형식만 사용한다.
- 배치 처리 결과는 HTTP 상태가 아니라 **응답 본문을 파싱**해 확인해야 한다.
  배치 구조가 유효하면 전부 거절이어도 200이며, per-event 결과는 `rejected`
  배열에 담긴다 (docs/api.openapi.yaml — EventBatchResponse).
- 같은 event_id 재전송은 안전하다(중복 저장 없음, `duplicate`로 보고).

### 적재 API 직접 호출 예시

```bash
curl -s -X POST http://localhost:3000/api/v1/event-batches \
  -H 'Authorization: Bearer dev-ingest-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "batch_id": "102947f0-46f6-4bf8-b736-043dbfd69a44",
    "sent_at": "2026-07-28T12:00:00.000Z",
    "events": [{
      "instance_id": "0fab3f2e-1894-41cd-b915-f99440a3ff32",
      "event_id": "3d935895-6d2c-42da-a87a-e482f8ac4992",
      "event_type": "session_login",
      "user_id": 1001, "character_id": 2001,
      "session_id": "session-abc", "channel_id": "channel-01",
      "payload": {"platform": "pc"},
      "occurred_at": "2026-07-28T11:59:59.123Z"
    }]
  }'
```

## 테스트

```bash
npm run lint && npm run build && npm test   # 정적 검사 + 단위 테스트
docker compose up -d db && npm run test:e2e # E2E (PostgreSQL 필요)
```

## 현재 구현 상태

- [x] 적재 API `POST /api/v1/event-batches` — 인증(401/403), 4MB 제한(413),
      멱등성 트랜잭션(§6.2), 부분 성공 + 카운트 불변식, 내부 데드라인 10초
- [x] 고정 데이터셋 / 생성기 / 전송 클라이언트 / seed / demo
- [x] 지표 API: DAU `GET /api/v1/metrics/dau`, 리텐션 `GET /api/v1/metrics/retention`
      — ADMIN_API_KEY 인증, zero-fill, 반개구간, matured/null 판정
- [ ] 지표 API: revenue / purchase-conversion / engagement — 미구현
      (demo에서 404 FAIL로 표시)
