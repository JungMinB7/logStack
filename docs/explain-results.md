# 주요 집계 쿼리 EXPLAIN 결과 요약

> design.md §7.1의 "주요 5개 집계 쿼리는 구현 시 EXPLAIN으로 인덱스 사용을
> 확인한다"에 대한 실측 기록. 재현 절차와 결과를 남긴다.

## 측정 환경·데이터

- 로컬 docker compose (PostgreSQL 16), 2026-07-28 측정
- 데이터: 생성기(`scripts/generate-events.ts --users 300 --days 31 --start 2026-06-01 --seed 7`)로
  적재한 **game_events 163,802행 / purchases 1,120행** (`ANALYZE` 실행 후 측정)
- 대상: `src/metrics/metrics.repository.ts`의 5개 쿼리에 조회 기간
  2026-06-01 ~ 2026-06-30을 대입해 `EXPLAIN (ANALYZE, BUFFERS)` 실행

## 결과 요약

| # | 쿼리 (repository 메서드) | 핵심 스캔 방식 | Execution Time |
|---|---|---|---|
| 1 | DAU (`dauByDay`) | `idx_events_type_time` Bitmap Index Scan (7,230행) | 6.5 ms |
| 2 | 리텐션 (`retentionByCohort`) | `idx_events_type_time` Bitmap Index Scan ×2 (first_login 전체 이력 + login_days) | 7.7 ms |
| 3 | 매출 (`revenueByDay`) | game_events는 `idx_events_type_time`, purchases는 Seq Scan (1,120행) | 3.6 ms |
| 4 | 전환율 (`conversionByDay`) | game_events는 `idx_events_type_time`, purchases는 Seq Scan | 4.2 ms |
| 5 | 참여율 (`engagementByDayType`, boss_clear) | `idx_events_type_time` Bitmap Index Scan ×2 (DAU 집합 + engaged 집합) | 8.0 ms |

## 해석

- **의도한 인덱스 사용 확인**: 다섯 쿼리 모두 game_events 접근이
  `(event_type, occurred_at)` 복합 인덱스 `idx_events_type_time`의
  Bitmap Index Scan으로 수행된다 — "타입 + 기간" 조건이 인덱스 선두 컬럼과
  일치한다는 design.md §7.1의 설계 의도대로다.
- **purchases의 Seq Scan은 정상**: 1,120행 규모에서는 플래너가 인덱스보다
  순차 스캔을 선택하는 것이 올바르다. 결제 행이 커지면
  `idx_purchases_time_currency`(occurred_at, currency)가 사용된다.
- **리텐션의 전체 이력 스캔**: first_login/login_days CTE는 설계상 기간 필터가
  없어(§9.2 — 코호트 오분류·end 밖 Dn 판정 방지) session_login 전체를 읽는다.
  현재 규모에서는 인덱스의 event_type 선두 조건으로 충분히 빠르나, 운영 규모의
  시간 보장은 §15의 사전 집계(user_first_login) 경로다 (§7.3, §10.7).

## 재현 방법

```bash
# 1) 대용량 데이터 적재 (서버 실행 중이어야 함)
npx ts-node scripts/generate-events.ts --users 300 --days 31 --start 2026-06-01 --seed 7 --out events.json
npx ts-node scripts/send-events.ts events.json

# 2) 통계 갱신 후 EXPLAIN (쿼리 원문은 src/metrics/metrics.repository.ts)
docker exec rusheight-test-db-1 psql -U app -d gamelogs -c "ANALYZE game_events; ANALYZE purchases;"
```
