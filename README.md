# RPG 게임 로그 적재 파이프라인 & 집계 API

제약이 있는 HTTP 전송 환경(120회/분, 요청 본문 4MB, timeout 30초)에서 게임 이벤트를
**유실 없이** 적재하고(event_id 멱등성), 운영 지표 5종(DAU·리텐션·매출/ARPU·결제
전환율·활동별 참여율)을 조회하는 서버.

- **기술 스택**: Node.js 24 · TypeScript · NestJS 11 (Express) · Prisma 6 · PostgreSQL 16 · Jest/Supertest · Docker Compose
- **구조**: Controller → Service → Repository 3층 (ADR-002 — Prisma/SQL은 `*.repository.ts`에만)

| 문서 | 내용 |
|---|---|
| [docs/design.md](docs/design.md) | [문제 1] 설계 문서 — 제약 분석, 아키텍처, API·스키마·지표 정의 |
| [docs/api.openapi.yaml](docs/api.openapi.yaml) | API 계약 (단일 기준) |
| [docs/assumptions.md](docs/assumptions.md) | 가정 목록 (A-1 ~ A-32) |
| [docs/decisions.md](docs/decisions.md) | ADR (브로커 미도입, 3층 구조) |
| [docs/explain-results.md](docs/explain-results.md) | 주요 5개 집계 쿼리 EXPLAIN 실측 |

## 1. 실행 방법 (깨끗한 환경 기준)

```bash
cp .env.example .env                # 기본값으로 바로 동작
docker compose down -v              # (재실행 시) 컨테이너·볼륨 초기화
docker compose up -d --build        # PostgreSQL 16 + 앱 빌드·기동
curl http://localhost:3000/health   # {"status":"ok"} 확인
```

앱 컨테이너가 기동 시 `prisma migrate deploy`로 마이그레이션을 자동 적용한다.
로컬 개발(핫 리로드)은 `docker compose up -d db` 후 `npm install && npm run start:dev`.

## 2. 환경변수

`.env.example`과 동일. **fail-closed** 표시 항목은 누락(공백 포함) 시 서버가
부팅을 거부하며, 적재 키와 관리자 키가 같아도 거부한다(역할 분리).

| 변수 | 필수 | 설명 |
|---|---|---|
| `DATABASE_URL` | O | PostgreSQL 연결 문자열. 코드가 `statement_timeout=5s`를 강제 부여 |
| `INGEST_API_KEY` | O (fail-closed) | 적재 API Bearer 키 (인스턴스별 키 — A-21) |
| `INGEST_INSTANCE_ID` | O (fail-closed) | 위 키에 매핑된 인스턴스. 배치 내 instance_id와 불일치 시 403 |
| `ADMIN_API_KEY` | O (fail-closed) | 지표 조회 Bearer 키 (적재 키와 반드시 상이) |
| `PORT` | X (기본 3000) | 서버 포트 |

## 3. 마이그레이션·시드

```bash
npm run prisma:migrate       # prisma migrate deploy (컨테이너는 자동 실행)
npm run prisma:migrate:dev   # 로컬 개발용 (스키마 변경 시)
npm run seed                 # 고정 데이터셋 12건을 "적재 API 경유"로 투입
```

seed는 DB에 직접 INSERT하지 않고 적재 API를 경유한다 — seed 자체가 인증·검증·
멱등성 트랜잭션의 동작 검증을 겸한다. purchases의 CHECK 제약(quantity ≥ 1,
amount_minor ≥ 0)은 Prisma 스키마가 표현하지 못해 마이그레이션 SQL에 직접 기술했다.

## 4. 적재 API 호출 예시

아래 명령과 출력은 실제 실행 결과다.

```bash
curl -s -X POST http://localhost:3000/api/v1/event-batches \
  -H 'Authorization: Bearer dev-ingest-key' -H 'Content-Type: application/json' \
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

```json
{"batch_id":"102947f0-46f6-4bf8-b736-043dbfd69a44","received_count":1,"accepted_count":1,"stored_count":1,"duplicate_count":0,"order_duplicate_count":0,"rejected_count":0,"rejected":[]}
```

- 카운트 불변식: `received = accepted + rejected`, `accepted = stored + duplicate`,
  `order_duplicate ⊆ stored`
- 같은 배치를 재전송하면 `duplicate_count`로 흡수된다 (행 수·매출 불변).
  `npm run seed`를 두 번 실행하면 직접 확인할 수 있다
- 배치 구조가 유효하면 전부 거절이어도 200 + per-event `rejected` 배열

### 전송측 유의사항

- **`occurred_at`은 시간대 지정자 필수** (`Z` 또는 `±hh:mm`). 없으면
  rejected(INVALID_ENVELOPE)
- 결과는 HTTP 상태가 아니라 **응답 본문을 파싱**해 확인 (design.md §4.2)
- 같은 event_id 재전송은 안전 (중복 저장 없음)

## 5. 지표 API 5종 호출 예시

고정 데이터셋(`npm run seed` 직후) 기준의 **실제 응답**이다. 모든 요청은
`Authorization: Bearer dev-admin-key` 헤더를 사용한다.

<details><summary><b>DAU</b> — GET /api/v1/metrics/dau?start=2026-01-01&end=2026-01-02</summary>

```json
{
  "meta": { "start": "2026-01-01", "end": "2026-01-02", "page": 1, "page_size": 31, "total": 2 },
  "summary": { "unique_users": 3 },
  "data": [
    { "date": "2026-01-01", "dau": 2 },
    { "date": "2026-01-02", "dau": 3 }
  ]
}
```
</details>

<details><summary><b>리텐션</b> — GET /api/v1/metrics/retention?start=2026-01-01&end=2026-01-02</summary>

```json
{
  "meta": { "start": "2026-01-01", "end": "2026-01-02", "page": 1, "page_size": 31, "total": 2 },
  "data": [
    { "cohort_date": "2026-01-01", "new_users": 2, "d1": 1, "d7": 1, "d30": 0.5,
      "matured": { "d1": true, "d7": true, "d30": true } },
    { "cohort_date": "2026-01-02", "new_users": 1, "d1": 0, "d7": 0, "d30": 0,
      "matured": { "d1": true, "d7": true, "d30": true } }
  ]
}
```

미성숙 코호트의 Dn은 0이 아니라 null이며, matured 판정은 "현재 UTC 일자 >
코호트+n일"이다 (조회 시점에 따라 값이 달라진다).
</details>

<details><summary><b>매출/ARPU</b> — GET /api/v1/metrics/revenue?start=2026-01-01&end=2026-01-02&currency=KRW</summary>

```json
{
  "meta": { "start": "2026-01-01", "end": "2026-01-02", "page": 1, "page_size": 31, "total": 2 },
  "summary": { "currency": "KRW", "revenue_minor": "15000", "active_users": 3, "arpu_minor": "5000.00" },
  "data": [
    { "date": "2026-01-01", "currency": "KRW", "revenue_minor": "10000", "active_users": 2, "arpu_minor": "5000.00" },
    { "date": "2026-01-02", "currency": "KRW", "revenue_minor": "5000", "active_users": 3, "arpu_minor": "1666.67" }
  ]
}
```

currency는 필수(통화 간 합산 금지), 금액은 BIGINT 초과 합계도 안전한 십진
문자열이다. **active_users는 통화 필터와 무관하다 — ARPU 분모는 활성 유저 전체
(design.md §9.3)**. summary의 active_users(3)는 기간 고유 유저이며 일별 합(5)이 아니다.
</details>

<details><summary><b>결제 전환율</b> — GET /api/v1/metrics/purchase-conversion?start=2026-01-01&end=2026-01-02</summary>

```json
{
  "meta": { "start": "2026-01-01", "end": "2026-01-02", "page": 1, "page_size": 31, "total": 2 },
  "summary": { "paying_users": 2, "active_users": 3, "conversion_rate": 0.6667 },
  "data": [
    { "date": "2026-01-01", "paying_users": 1, "active_users": 2, "conversion_rate": 0.5 },
    { "date": "2026-01-02", "paying_users": 1, "active_users": 3, "conversion_rate": 0.3333 }
  ]
}
```

분자는 활성 유저 집합과의 교집합(0~1 구조적 보장), summary는 일별 비율의 평균이
아니라 기간 고유 유저로 재계산된다.
</details>

<details><summary><b>[제안 지표] 활동별 참여율</b> — GET /api/v1/metrics/engagement?start=2026-01-01&end=2026-01-01&event_type=boss_clear</summary>

```json
{
  "meta": { "start": "2026-01-01", "end": "2026-01-01", "page": 1, "page_size": 31, "total": 1 },
  "data": [
    { "date": "2026-01-01", "event_type": "boss_clear", "engaged_users": 1, "dau": 2, "engagement_rate": 0.5 }
  ]
}
```

event_type 생략 시 13개 타입 전체의 (일 × 타입) 격자를 반환한다 — 페이지네이션이
실질 필요한 유일한 endpoint. 정의·활용 의도는 design.md §9.5.
</details>

공통: 반개구간 `[start, end+1일)` UTC, zero-fill(이벤트 없는 날도 행 반환),
date ASC 정렬, 최대 366일·page_size 100, 잘못된 파라미터는 400 + 통일 에러 형식
(`INVALID_DATE_RANGE`, `RANGE_TOO_LARGE`, `INVALID_CURRENCY`, `UNKNOWN_EVENT_TYPE`).
data와 summary는 REPEATABLE READ 스냅샷에서 함께 읽어 한 응답 내 정합이 보장된다.

## 6. 샘플 데이터 생성·적재·검증

### 고정 데이터셋 (정답을 손으로 계산 가능 — design.md §12.1)

`test/fixtures/deterministic-events.ts`에 event_id까지 고정된 12건과 각 지표의
기대값 상수가 정의되어 있다. **유저1의 1/1 결제는 같은 event_id로 2회 등장**해
중복 제거를 증명한다.

| 일자 (UTC) | 이벤트 | 기대 결과 |
|---|---|---|
| 2026-01-01 | 유저1·2 로그인, 유저1 결제 10,000원(같은 event_id 2회), 유저1 boss_clear | DAU 2, 매출 10000, ARPU 5000.00, 전환율 0.5, boss_clear 참여율 0.5 |
| 2026-01-02 | 유저1·2·3 로그인, 유저2 결제 5,000원 | DAU 3, 매출 5000, 전환율 0.3333 |
| 2026-01-08 | 유저1·2 로그인 | 01-01 코호트 D7 = 1.0 |
| 2026-01-31 | 유저1 로그인 | 01-01 코호트 D30 = 0.5 |

```bash
npm run seed   # 첫 실행: stored 11 / duplicate 1, 재실행: 전량 duplicate (멱등성)
npm run demo   # 적재 후 지표 5종을 기대값과 대조 — 전부 PASS 시 종료 코드 0
```

> demo 기대값은 "고정 데이터셋만 적재된 상태" 기준이다. E2E·생성기 데이터가
> 남아 있으면 초기화 후 재시드:
> `docker exec rusheight-test-db-1 psql -U app -d gamelogs -c "TRUNCATE purchases, game_events"` → `npm run seed`

### 임의 데이터 생성기

```bash
npx ts-node scripts/generate-events.ts \
  --users 10 --days 3 --start 2026-02-01 \
  --duplicates 0.05 --shuffle --seed 42 --out events.json
npx ts-node scripts/send-events.ts events.json   # 500건/3MB 상한 배칭 전송
```

`--duplicates`는 재전송 중복(같은 event_id 재등장), `--shuffle`은 "시간순으로
도착하지 않는다" 제약을 재현한다. 전송 클라이언트는 응답 본문 파싱·batch_id
대조·카운트 불변식 검증까지 수행한다.

## 7. 처리량 검증 (실측)

전송 제약의 이론 상한 시나리오 — **10개 논리 인스턴스 × 2 req/s(순차 전송,
in-flight 1) = 20 req/s, 배치당 15~150건** — 를 2분간 전송한다.

```bash
npx ts-node scripts/load-check.ts    # 기본 120초. --duration-sec 등 옵션 지원
```

실제 실행 결과 (로컬 docker compose, 2026-07-28):

```json
{
  "duration_sec": 120,
  "requests": 2400,
  "achieved_rps": 20,
  "events": 200766,
  "events_per_sec": 1673,
  "stored": 200766,
  "success_rate": 1,
  "client_latency_ms": { "p50": 22, "p95": 38, "max": 88 },
  "server_batch_duration_ms": { "samples": 2400, "p50": 13, "p95": 29, "max": 79 }
}
```

해석: 이론 상한 20 req/s(≈1,670 이벤트/초 — 피크 가정 1,500건/초 상회)에서
2,400 요청·200,766건이 유실·거절 없이 전량 저장됐고, 서버 배치 처리 p95는
29ms다. 순차 전송 모델의 인스턴스당 요청 간격 500ms 대비 약 17배 여유이며,
배치 처리를 직렬로 가정해도 초당 30요청 이상을 소화하는 수준이다. **120회/분
한도는 전송측 제약**이고, 서버는 배칭 수용(500건/4MB)과 멱등성(event_id PK)으로
이 제약 하의 전송자를 지원한다(서버 측 rate limit·429는 미구현 — 아래 한계 참조).
이 수치는 **로컬 docker 환경 기준**이며 운영 규모(수십억 행)의 보장이 아니다
(design.md §10.7). 집계 쿼리의 인덱스 사용 실측은
[docs/explain-results.md](docs/explain-results.md) 참조 (163k행에서 5개 쿼리 모두
`idx_events_type_time` 사용, 3.5~8ms).

## 8. 설계 대비 변경·구현 결정

설계 문서(design.md)와 어긋나는 변경은 없으며, 아래는 구현 중 확정한 세부 결정이다.

- **배치 내 동일 event_id 선제 dedupe**: 같은 `INSERT ... VALUES` 문 안에 동일
  PK가 두 번 들어가는 경우를 서비스에서 먼저 제거(첫 등장만 저장, 이후는
  duplicate로 계상) — 문장 내 PK 충돌로 파생 INSERT가 실패하는 경로 차단
- **UUID 소문자 정규화**: PostgreSQL의 `RETURNING`은 정규형(소문자)을 반환하므로
  event_id·instance_id를 저장·비교 전에 소문자로 통일. **rejected의 event_id는
  수신 원문 그대로 반환**한다(전송측 outbox 대조 편의)
- **`app.setup.ts`로 부트스트랩 단일화**: 4MB 제한·body-parser 에러 매핑을
  main.ts와 E2E가 같은 함수로 공유 — 테스트와 실서버의 동작 차이 제거
- **413은 본문 drain 후 응답**: 수신을 끝내기 전에 응답하면 업로드 중인
  클라이언트가 ECONNRESET으로 413 본문을 못 받는다. 한도 2배(8MB) 초과 폭주
  업로드는 즉시 절단
- **청크형 비-JSON은 400 안전 거부** (의도적 한계): Content-Length 없는 비-JSON
  전송은 버퍼링 없이 400으로 거부하고, 스트림 수준 크기 제한은 프록시 책임
  (design.md §2.3·§16)
- **HTTP 데드라인(10초)은 응답 절단만 수행**: 롤백 보장은 DB 수준
  timeout(statement_timeout 5초, 트랜잭션 8초)이 담당. 503이 "저장 실패"를
  보장하지 않지만 재시도가 event_id 멱등성으로 흡수되어 유실·중복 없음 (§16)
- **매출 합계는 `SUM(...)::text`**: 개별 금액이 안전 정수 범위여도 합계가
  signed BIGINT를 넘을 수 있어 십진 문자열로 반환, ARPU는 BigInt 정수 연산으로
  소수 2자리 반올림 (부동소수점 미사용)
- **data·summary 단일 스냅샷**: 두 쿼리 사이의 동시 커밋으로 한 응답 안의
  값이 어긋나지 않도록 REPEATABLE READ 트랜잭션으로 묶음. P2028 등 재시도
  가능 오류는 503으로 매핑
- **`occurred_at` 시간대 지정자 필수**: 오프셋 없는 ISO8601은 DB 세션 시간대에
  따라 해석이 흔들리므로 rejected 처리 (계약 "ISO8601 UTC"의 강제)
- **fail-closed 환경변수 검증**: 필수 키 누락·공백·적재/관리자 키 동일 시 부팅 거부
- **Prisma ^6 고정**: 7.x가 존재하나 제출 안정성을 위해 검증된 6.x 유지
- **event_type은 PG enum이 아닌 VARCHAR + DTO 허용 목록** (design.md §7.4 — 새
  타입 추가에 마이그레이션 불필요)

## 9. 가정 / 한계·미구현

가정 전체는 [docs/assumptions.md](docs/assumptions.md) (A-1~A-32). 핵심만 요약:
모든 시각·일자 경계는 UTC(A-1) · 지표는 user_id 기준(A-14) · 리텐션은 exact-day(A-15) ·
amount_minor는 주문 총액(A-28) · order_id 전역 유일(A-27) · 재전송 내용 동일 가정과
first-write-wins(A-7).

한계·미구현 (상세: design.md §16):

- **서버 측 rate limit(429 + Retry-After) 미구현** — 전송측이 예산(120회/분의
  50%)을 준수하는 정상 경로에서는 발동하지 않아 4순위로 미룸 (design.md §13).
  계약(openapi)에는 정의되어 있음
- Swagger UI, 에러 응답의 request_id 미구현 (계약상 선택 필드)
- 환불·부분취소 미지원(총매출 기준), 다중 통화는 스키마·API 지원하되 샘플은 KRW
- 운영 규모 raw 집계의 응답 시간 미보장 — 확장 경로는 design.md §15 (사전 집계, 큐)
- 모든 지표는 조회 시점 기준 가변 결과 (늦은 이벤트로 과거 값 변경 가능, A-31)
- 503 ≠ 저장 실패 보장 / 청크형 비-JSON 크기 제한은 프록시 위임 (§16)

## 10. 테스트

```bash
npm run lint && npm run build && npm test   # 정적 검사 + 단위 12건
docker compose up -d db && npm run test:e2e # E2E 45건 (PostgreSQL 필요)
```

E2E는 실행 시 테이블을 비우므로, 이후 demo를 보려면 `npm run seed`를 다시 실행한다.

### design.md §12 시나리오 커버리지 (45 e2e + 12 unit, 전부 green)

| §12.2 시나리오 | 검증 위치 |
|---|---|
| 1. 동일 event_id 중복 전송 | ingestion 2(전량 재전송)·9(대소문자 변형)·배치 내 중복 — 최종 보장은 DB PK |
| 2. 다른 event_id + 동일 order_id | ingestion 3 (원본 2·결제 1·order_duplicate 1) |
| 3. 커밋 후 응답 유실 → 전체 재전송 | ingestion 2 + metrics "재전송 후 5개 지표 응답 불변" |
| 4. 부분 성공 (invalid 혼합) | ingestion 4·4-1 (전부 거절도 200) |
| 5. 과거 로그인 늦은 도착 → 코호트 보정 | metrics 리텐션 보정 테스트 |
| 6. UTC 자정 경계 (23:59:59.999 / 00:00:00.000) | metrics DAU·결제 자정 테스트 |
| 7. 전일 로그인 + 당일 결제 (교집합) | metrics 전환율·참여율 제외 테스트 (일별·기간 grain 각각) |
| 8. 관찰 진행 중 Dn → matured=false·null | metrics 시간 고정(Date.now 주입) 테스트 |
| 9. order_id 충돌의 배치 내 격리 | ingestion 6 |
| 10. 잘못된 키 / start > end | ingestion 5-1·5-2·5-3, metrics 401/400 |

추가 커버: 4MB 초과 413(JSON·비JSON 모두, drain 후 응답), 청크형 400 안전 거부,
BIGINT 합계 오버플로우, 통화 혼합 분리, summary 페이지네이션 독립성,
data·summary 스냅샷 일관성, 스냅샷 트랜잭션 만료 → 503, 최대 배치 500건,
날짜 경계(1970~9999), fail-closed 부팅 검증(단위).

## 11. AI 활용 방식

구현 전담 에이전트 1개와 읽기 전용 검토 에이전트 3개(아키텍처 리뷰어, 지표
리뷰어, 검증 라운드), 그리고 독립 적대 검토(Codex — 저장소의 `codex/*` 브랜치
2개가 그 증빙)로 역할을 분리해 운영했다. 모든 에이전트는 설계·규칙 문서
(AI_RULES.md, docs/spec·design·assumptions·decisions)를 단일 기준으로 삼았고,
검토 발견은 "실패 테스트 재현 → 수정 → 회귀 테스트 고정" 순서로만 반영했다.
이 체계로 제출 전에 잡은 대표 결함 2건: ① 대문자 UUID event_id 입력 시
PostgreSQL RETURNING(소문자 정규형)과의 비교 불일치로 결제 파생 행이 조용히
유실되는 버그(소문자 정규화로 수정), ② 안전 정수 범위 금액들의 기간 합계가
signed BIGINT를 넘어 매출 조회가 실패하는 오버플로우(`SUM::text` + BigInt
연산으로 수정). 각각 회귀 테스트로 잠갔다.
