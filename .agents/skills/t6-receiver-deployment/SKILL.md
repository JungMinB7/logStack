---
name: t6-receiver-deployment
description: "T6의 receiver EC2·내부 ALB·ACM·Route53·SSM 키 주입을 구현하고 승인된 연결 검증을 인계한다."
---

# T6 수신 인프라 배포

## 기획의 범위와 완료 조건

원문 범위: receiver EC2 + user_data 배포, 내부 ALB + ACM + Route53,
SSM 파라미터에서 키 주입.
원문 완료 조건: SSM 포트포워딩으로 /health 200, 적재 curl 성공.

## 담당·입력

infra-developer가 infra/를 작성하고 infra-reviewer가 독립 검토한다.
서버 코드 결함·패키징 변경이 필요하면 backend-developer의 별도 승인 범위로 넘긴다.
AI_RULES.md, plan-aws.md T6·D1/D5, docs/design-aws.md §2·§3·§7·§9,
API 계약, 실제 서버 build/start/migration 설정, T4/T5 승인·적용 기록을 읽는다.
receiver AMI/타입, 변경 불가능한 배포 리비전, Node/런타임, 도메인·zone·인증서,
SSM 키 목록/DB 자격 증명 경로, app/management 통신 경로를 확인한다.

## 절차

1. T4/T5 자원과 DB 연결 준비 상태를 확인한다. receiver를 프라이빗 앱 서브넷에 둔다.
2. D5가 user_data+git clone이면 그 결정을 따른다. 임의 Docker/ECR 전환을 하지 않는다.
   변경 가능한 main/latest를 그대로 배포 리비전으로 삼지 말고 승인된 commit/artifact를 고정한다.
   private repo 인증이나 패키지 공급 경로가 없으면 비밀값 하드코딩 대신 미결로 보고한다.
3. 현재 package scripts와 build 산출물에 맞춰 receiver 서비스를 구성한다.
   DB 준비 확인→기존 migration→앱 시작의 실패 처리, 중복 실행, 재부팅을 검토한다.
   비권한 실행 사용자/로그/서비스 재시작 정책은 승인 범위에서 정한다.
4. SSM에서 키/DB 비밀값을 가져오는 코드는 인스턴스 런타임에서만 실행한다.
   Terraform은 이름·ARN·IAM만 처리한다. 10개 적재 키와 ADMIN키, DB 비밀값 목록을 구분한다.
   현재 서버가 받는 키 매핑 형식을 읽고 그대로 사용하며 포맷 변경은 별도 승인받는다.
5. 내부 ALB의 internal 속성, 443 TLS listener, receiver target port 3000,
   /health 검사, 승인된 SG 체인·타임아웃/응답 크기 경로를 검토한다.
   앱이 보장하는 본문 한도를 ALB가 자동으로 대신 보장한다고 가정하지 않는다.
6. 보유 도메인 기반 ACM과 Route53을 구성한다. 인증서 도메인 검증용 공개 DNS와
   내부 ALB를 가리키는 서비스 DNS 범위를 구분한다. private zone만으로 공개 인증서
   검증을 끝냈다고 가정하지 않는다. 자체 서명·TLS 검증 우회로 막힌 검증을 통과시키지 않는다.
7. sender/receiver CloudWatch 수집 중 receiver 범위, chrony/SSM, cloud-init 실패 진단을 준비한다.
8. fmt/validate/plan 및 user_data 구문 검증 후 변경·삭제·교체를 리뷰한다.
   T9의 외부 ALB/정적 화면은 만들지 않는다.
9. 사람 apply 후 해당 환경의 검증 승인을 받아 SSM 포트포워딩으로 정확한 /health 200을 확인한다.
   승인된 테스트 이벤트로 적재 curl의 ACK 불변식/DB 저장을 확인한다.
   실수로 생산 DB를 seed/초기화하지 않는다. 비밀값을 로그·명령 히스토리에 넣지 않는다.
10. T5에서 대기한 receiver→DB psql 결과를 확보하여 인계 상태를 갱신한다.
    SSM으로 앱에 직접 접근한 성공과 내부 ALB HTTPS 성공은 별도 증거다.
    sender-sg에서의 검증 호스트가 아직 없으면 내부 end-to-end 검증은 T7 인계로 남긴다.
    curl 검증만을 위해 미승인 SG 경로/임시 EC2를 추가하지 않는다.

## 산출물·판정

변경 파일, 배포 리비전·명령/산출물, private endpoint/target/SSM 식별자,
plan/비용/사람 적용 대기, /health·curl ACK·DB 증거,
TLS/ALB 경로 확인 여부, T5 종료 조건과 T7 인계 목록.
HTTP 200만 있고 ACK/DB 확인이 없으면 적재 무유실까지 주장하지 않는다.

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