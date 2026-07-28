> 이 파일은 Codex 전용 규칙이다. Claude Code와 그 서브에이전트
> (backend-developer 포함)는 이 파일이 아니라 CLAUDE.md와
> .claude/agents/의 각자 정의를 따른다.

# 프로젝트 불변 규칙 (Project Invariants)

이 규칙은 절대 어기면 안 된다. 코드·문서·테스트 모두에 적용된다.

## 데이터 규칙
1. event_id가 멱등성 키다. 같은 event_id가 여러 번 들어와도
   행이 중복 생성되거나 매출이 중복 집계되면 안 된다.
   최종 보장은 애플리케이션 코드가 아니라 DB 유니크 제약(PK)이 한다.
2. 지표 계산은 항상 occurred_at 기준이다. received_at을 쓰면 안 된다.
   (이벤트는 시간순으로 도착하지 않기 때문)
3. 모든 시각은 UTC로 저장한다 (PostgreSQL TIMESTAMPTZ).
   지표의 "일자" 경계도 UTC 기준이며, 이 가정은 docs/assumptions.md에 명시되어 있다.
4. 금액은 최소 화폐 단위 정수(amount_minor)로 저장한다.
   부동소수점(9.9 같은 값) 저장 금지.
5. 서로 다른 통화의 매출을 합산하지 않는다.
   매출 API는 currency 파라미터를 받거나 통화별로 결과를 분리한다.

## 지표 정의 규칙
6. 리텐션: 최초 로그인 일자를 코호트로 하고,
   정확히 D+1 / D+7 / D+30 일에 로그인했는지 기준으로 계산한다.
   아직 기간이 지나지 않은(matured되지 않은) 코호트는 0%가 아니라 null을 반환한다.
7. ARPU 분모는 활성 사용자 수(session_login 고유 user_id)다.
   결제 사용자 수로 나누는 것은 ARPPU이며 둘을 혼동하지 않는다.
8. 결제 전환율 = 기간 내 결제 고유 사용자 / 기간 내 로그인 고유 사용자.
   월 단위 조회 시 일별 비율의 평균을 쓰지 않고 그 기간의 고유 사용자로 다시 계산한다.

## API 규칙
9. 적재 API는 인증(API 키) 필수. 인증 실패는 401, 키-인스턴스 불일치는 403.
10. 시계열/목록 응답에는 페이지네이션 또는 명확한 상한이 있어야 한다.
11. start > end 같은 잘못된 파라미터는 400과 통일된 에러 형식으로 응답한다.

## 구조 규칙 (3층 아키텍처) — 이 프로젝트의 핵심 구조 규칙
12. Controller는 Prisma를 직접 호출하지 않는다. Service만 호출한다.
13. SQL(raw query 포함)과 Prisma 호출은 *.repository.ts 파일에만 존재한다.
14. Service는 Express의 Request/Response 객체를 모른다.
    (HTTP 관심사는 Controller, 업무 규칙은 Service, DB는 Repository)

## TypeScript 함정 방지
15. Prisma의 BIGINT 컬럼은 JS BigInt로 반환되며 JSON.stringify가 실패한다.
    API 응답 직전에 반드시 Number 또는 문자열로 변환한다.
16. payload는 any가 아니라 unknown으로 받고, 런타임 검증(class-validator) 후 사용한다.

## 의존성 규칙
17. Kafka, Redis, RabbitMQ 등 새 인프라 의존성을 추가하지 않는다.
    필요하다고 판단되면 코드를 먼저 쓰지 말고 docs/decisions.md에 트레이드오프를 기록하고 멈춘다.

# 필수 검증 명령 (코드 변경 후 항상 실행)

- npm run lint
- npm run build
- npm test
- npm run test:e2e

## v2 추가 불변 규칙 (design.md v2 반영)

18. 적재 응답 카운트 불변식: received = accepted + rejected,
    accepted = stored + duplicate, order_duplicate ⊆ stored.
    이 불변식은 모든 적재 E2E 테스트에서 검증한다.
19. 결제 파생(purchases) 행은 "이번 트랜잭션에서 새로 저장된 원본"에 대해서만 생성한다.
    order_id 충돌 시 원본은 저장하고 파생만 생략하며 order_duplicate로 보고한다.
20. 모든 지표 기간은 반개구간 [start 00:00 UTC, end+1일 00:00 UTC)이다.
    BETWEEN으로 상한을 포함시키지 않는다.
21. 전환율·참여율의 분자는 반드시 분모 집합과의 교집합이다 (0~1 범위 구조적 보장).
22. 리텐션: 최초 로그인은 전체 이력 MIN / start·end는 코호트 일자 필터 /
    Dn 판정은 end 밖 데이터도 조회 / matured = 현재 UTC 일자 > 코호트+n.
23. 시계열 응답은 zero-fill(모든 달력 일자 반환), date ASC 정렬,
    summary는 페이지네이션과 무관하게 기간 전체로 계산한다.
24. 반올림: 비율은 소수 4자리(5자리에서 반올림), arpu_minor는 소수 2자리 문자열.
25. 배치 구조가 유효하면 전부 거절이어도 HTTP 200 + per-event 결과다 (422 없음).
26. DB 수준 timeout(statement_timeout 5초, 트랜잭션 8초)은 롤백을 보장한다.
    HTTP 데드라인 10초는 응답 절단만 수행하며, 절단 후 커밋될 수 있는 한계와
    그 안전성 근거(event_id 멱등성으로 재시도 흡수)는 design.md §16에 기술되어 있다.
27. rejected.message는 서버 정의 문구(200자 이하)이며 사용자 입력을 반사하지 않는다.