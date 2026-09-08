---
name: t9-dashboard
description: "T9의 외부 ALB와 metrics API만 소비하는 정적 대시보드 1페이지를 구현·검증한다. 앱/infra 작성 범위를 분리한다."
---

# T9 동료용 대시보드

## 기획의 범위와 완료 조건

원문 범위: 외부 ALB + 보유 도메인(Route53/ACM), receiver ServeStatic 정적 1페이지,
DAU 라인차트, 매출·전환율 카드, 리텐션 표, 참여율 히트맵.
데이터는 metrics API만 호출하고 ADMIN 키를 사용자가 입력한다.
원문 완료 조건: 도메인 접속으로 지표 5종 표시, 외부 ALB에서 적재 경로404 확인.

## 담당·입력

메인은 infra 작업과 앱 작업을 나누어 승인·순차 인계한다.
infra-developer: infra/의 외부 ALB·listener·SG·ACM·Route53.
backend-developer: 승인된 정적 디렉터리와 최소 NestJS ServeStatic 연결·테스트·문서.
package/lock 변경이 필요하면 이유와 범위를 별도 승인받는다.
infra-reviewer/metrics-reviewer/docs-auditor는 필요한 범위를 읽기 전용으로 검토한다.
AI_RULES.md, plan-aws.md T9/§1, docs/design-aws.md §11,
docs/design.md §9·§10과 OpenAPI의 실제 5개 경로/필드/인증을 읽는다.
기존 외부 SG, 도메인·zone, 허용 CIDR, 정적 route/asset 목록, 현재 패키지/버전을 확인한다.

## 절차

1. 설계 결정을 유지한다. Grafana/DB 직결/새 집계 API/서버 지표식 복제는 하지 않는다.
   UI는 기존 metrics 응답을 소비하며 SQL·코호트·ARPU·전환율을 다시 계산하지 않는다.
2. 앱 수정 전에 정확한 파일 범위를 합의한다. 기존 적재 controller/transaction/metric SQL을
   정적 화면 구현 때문에 리팩터링하지 않는다. 기존 src/ 금지 요청이 유지된다면
   ServeStatic 연결에 필요한 예외 범위를 사람이 승인할 때까지 그 부분은 멈춘다.
3. 화면은 기간·통화·필요 활동 필터와 로딩/실패/빈값 상태를 제공한다.
   DAU/revenue/purchase-conversion summary를 기간 카드에 사용하고 페이지별 합으로 만들지 않는다.
   retention/engagement는 계약에 없는 summary를 UI에서 지표 정의로 새로 만들지 않는다.
4. page_size 상한과 meta.total을 읽고 모든 필요한 페이지를 다루거나 명확한 페이지 UI를 제공한다.
   31행/100행만 받아 366일이나 13타입 전체를 표시한 것처럼 만들지 않는다.
   과도한 병렬 요청과 중복 refresh를 피하고 이전 필터 응답이 새 화면을 덮어쓰지 않게 한다.
5. null/0을 구분한다. 미성숙 리텐션·분모0은 0%로 그리지 않는다.
   비율 표시의 ×100과 지표 계산은 다르다. 금액 문자열을 Number로 무심코 바꾸지 않는다.
   통화별 minor 단위를 확인하고 KRW를 포함한 모든 통화를 /100으로 변환하지 않는다.
   날짜 경계는 UTC이며 브라우저 현지 시각으로 다른 일자로 바꾸지 않는다.
6. ADMIN 키는 사용자가 입력해 API Bearer 헤더로만 보낸다.
   저장소/번들/HTML/URL/query/log/screenshot에 넣지 않는다.
   기본은 메모리에만 보관하고 localStorage/sessionStorage에 자동 저장하지 않는다.
   같은 origin의 승인된 metrics 경로로만 보내고 외부 분석 도구/CDN에 전달하지 않는다.
   이 항목은 키 입력 방식을 안전하게 구현하기 위한 추가 절차이며 계정 인증 방식 변경이 아니다.
7. 정적 자산/ServeStatic fallback이 /api/*나 /health를 가로채지 않게 구성한다.
   새로운 차트 의존성은 필요성을 검토하고 승인한다. 데모 키를 화면 기본값으로 넣지 않는다.
8. 외부 ALB는 승인 CIDR의443만 받고 HTTPS 인증서/도메인을 사용한다.
   명시된 정적 경로와 GET /api/v1/metrics/*만 전달하고 기본 응답은404로 둔다.
   /api/v1/event-batches는 메서드와 관계없이 외부에서 고정404가 되도록 규칙·우선순위를 검토한다.
   catch-all /* 포워드나 SPA fallback으로 차단을 우회하지 않는다.
   허용 CIDR가 없으면 0.0.0.0/0으로 임시 개방하지 않는다.
9. 앱 변경은 lint/build/unit/e2e와 계약·화면 테스트, infra 변경은 fmt/validate/plan 리뷰를 수행한다.
   단위/fixture 기대값을 대시보드에 맞춰 바꾸지 않는다.
10. 사람 apply 후 승인된 도메인에서 5종 실제 데이터를 브라우저로 확인한다.
    허용되지 않은 호출과 /api/v1/event-batches의404를 ALB 경유로 확인한다.
    유효 테스트 자격 증명 사용 시에도 적재가 되지 않는지 승인된 안전한 방식으로 확인한다.
    앱 직접 포트에서의404를 외부 ALB404 증거로 바꾸지 않는다.
    브라우저 도구가 없으면 HTTP 검증과 미실행 UI 검증을 분리해 보고한다.

## 산출물·판정

infra/앱 변경별 파일·담당·검증, 5개 지표-API-화면 매핑,
페이지/null/금액/키 처리 근거, 도메인·허용 CIDR(필요 시 가림),
외부 적재404 증거, 회귀 결과, 비용 변화와 남은 운영 한계.
인프라 계획만 만들거나 정적 HTML만 열어본 상태를 T9 전체 완료라 하지 않는다.

## 공통 실행 경계 — 스킬 호출이 권한을 확대하지 않는다

- 적용되는 AGENTS.md/하위 지침과 AI_RULES.md를 우선 확인한다. 현재 요청이 허용한 단계·파일만 다룬다.
- 먼저 git 브랜치/HEAD/status와 기존 변경·실행 프로세스를 확인한다. 기존 수정·데이터·증거를 보존한다.
- 메인이 작업을 조율하고 작성자는 동시에 1명만 둔다. 리뷰어는 파일/테스트를 수정하지 않는다.
  이 스킬을 읽었다고 에이전트가 자동 생성되는 것은 아니다. 실제 위임할 때 역할·경로·검증 범위를 전달한다.
- terraform apply/destroy는 사람이 실행한다. CLI/SDK/terraform test/provisioner로 우회하지 않는다.
  자격 증명·backend·입력 부재를 가짜 값으로 메우지 않는다. 운영 대상 변경은 별도 승인 없이는 하지 않는다.
- 시크릿 값은 조회·출력·커밋하지 않는다. 인스턴스 runtime 주입용 코드는 이름/ARN과 IAM만 다룬다.
- DB 초기화·부하·서비스 중단은 정확한 계정/환경/대상/범위와 복구 계획에 대한 명시적 승인 후에만 한다.
- 단계 표의 완료 조건을 임의 완화하지 않는다. 읽기/코드 작성/정적 검증/plan 리뷰/사람 apply/실측을 분리한다.
- 근거는 현재 저장소와 실행 로그다. 오래된 첨부본으로 최신 T3 보고·design-aws.md를 덮어쓰지 않는다.
- 결과는 PASS/FAIL/BLOCKED/NOT_RUN으로 구분한다. 실행한 명령·종료 코드·시각·버전·증거 경로를 적는다.
- 원래 과제/기획과 충돌하는 안전상 보강·새 선택은 제안으로 표시하고 사람이 기준 문서를 정리하기 전 강행하지 않는다.
- 별도 요청 없이 git add/commit/push나 브랜치 조작을 하지 않는다.