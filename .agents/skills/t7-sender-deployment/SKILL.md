---
name: t7-sender-deployment
description: "T7의 count=10 sender EC2·UUID별 키 매핑·systemd·CloudWatch를 배포 준비하고 실제 유입 증거를 확인한다."
---

# T7 전송 인스턴스 배포

## 기획의 범위와 완료 조건

원문 범위: count=10 EC2, 인스턴스별 키 매핑, systemd로 sender 가동.
원문 완료 조건: CloudWatch에서 10대 전송 로그, DB에 유입 확인.

## 담당·입력

infra-developer는 infra/ 배포·IAM·서비스 구성을 작성한다.
sender/ 또는 package/lock의 빌드 변경이 필요하면 backend-developer에게 별도 승인으로 맡긴다.
한 작업 트리에 작성자를 동시에 두지 않는다.
AI_RULES.md, plan-aws.md T7, docs/design.md §4, 최신 docs/design-aws.md §4·§5·§9,
T3 최종 보고/실제 sender 엔트리·설정·빌드, T4~T6 적용/검증을 읽는다.
10개의 논리 UUID↔SSM 키 경로↔Terraform count.index↔EC2 식별 매핑과
receiver URL/TLS, 아티팩트 리비전, outbox 저장·보존 정책, CloudWatch/IAM을 확보한다.

## 절차

1. 검증된 T3 코드를 재사용한다. 이전 소크 통과를 새 AWS 실행 결과로 쓰지 않는다.
   root build가 sender를 제외할 수 있으므로 실제 실행할 산출물·시작 명령을 먼저 확인한다.
   타입 검사만으로 배포 가능하다고 결론내리지 않는다.
2. 원문 count=10을 유지한다. for_each 등 주소 구조 변경을 임의 적용하지 않는다.
   count.index 매핑의 순서가 바뀌어 키/인스턴스/잔여 outbox가 잘못 연결되지 않게 검증한다.
3. 논리 instance_id는 API가 요구하는 UUID다. EC2의 i-... ID나 sender-01 이름으로 대체하지 않는다.
   API 키별 허용 UUID, 유저/주문 ID 생성 범위, 10×30명 시뮬레이션 조건을 확인한다.
4. 각 인스턴스가 필요한 키만 읽도록 IAM·SSM 경로를 검토한다. ADMIN/DB/다른 sender 키를
   모두 읽는 공용 권한을 ‘키 매핑이 분리돼 안전’이라고 판단하지 않는다.
   Terraform이 actual key value를 읽거나 state/user_data에 넣지 않게 한다.
5. 배포 리비전과 CPU/Node/아티팩트 호환성, 비권한 사용자, outbox 위치·권한,
   실패 저널, 디스크 여유, 단일 작성자, 서비스 시작·종료·재시작 정책을 구성한다.
   SIGTERM 처리 시간을 주고 임의 삭제로 pending을 줄이지 않는다.
6. 1초/500건/3MB, in-flight=1, 자체 60req/분, ACK 검증,
   Retry-After+jitter, 401/403 중단, fsync 이후 기록 성공과 checkpoint 의미를 유지한다.
   systemd 무한 재시작이 고정 창 카운터를 리셋하며 인증 실패 중단을 무력화하지 않는지 확인한다.
7. T3의 실패 ID 상한/저널 폴백을 그대로 사용하고 큰 저널의 동기 I/O·재시작 한계를 운영에 인계한다.
   프로세스 재시작 내구성과 EC2 교체/볼륨 삭제 내구성을 구분한다.
   후자 보장이 미정이면 새로운 저장 인프라를 임의 도입하지 말고 한계·선택을 보고한다.
8. 10대 chrony·SSM·CloudWatch의 경로, 로그 보존과 비용을 구성한다.
   로그는 논리 instance_id로 구분하고 키/이벤트 payload 전체를 출력하지 않는다.
9. fmt/validate/plan과 서비스/부트스트랩 구문 검증을 수행한다.
   count 감소·볼륨 교체·키 재매핑이 있으면 사람 리뷰 전 적용하지 않는다.
10. 사람 apply 후 승인된 가동 확인에서 10개 각각의 CloudWatch 전송·ACK와 DB 유입을 확인한다.
    단일 인스턴스 로그 또는 한 개 log group 존재만으로 10대 완료 처리하지 않는다.
    내부 ALB HTTPS/인증서·DNS 확인도 이 실제 sender 경로에서 기록한다.

## 산출물·판정

10대별 UUID/EC2/키 경로(값 제외)/로그 스트림/DB 유입 확인 표,
배포 리비전·빌드/시작 명령, outbox 내구성 범위, plan/비용/사람 실행 상태,
T8 run별 독립 event_id 증거 수집 계획.
이 단계에서 장애 주입·스로틀 해제·30분 소크를 자동 실행하지 않는다.

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