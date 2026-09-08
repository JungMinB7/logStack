---
name: infra-audit
description: "배포·데모 전 Terraform plan과 보안·비용·재현성을 감사한다. apply/destroy와 자동 수정은 하지 않는다."
---

# 인프라 감사

## 목적과 담당

배포 전 또는 데모 전 보안·비용·재현성을 감사한다. 결함을 자동 수정하지 않는다.
메인 또는 승인된 infra-developer가 검증 명령을 실행하고 infra-reviewer가 읽기 전용으로 독립 검토한다.
리뷰어에게 init/plan 생성이나 변경을 맡기지 않는다.

## 입력

현재 infra/, Terraform/provider 버전·lockfile, backend/root 목록,
plan-aws.md와 docs/design-aws.md, 승인된 SG·라우트·Endpoint·IAM 표,
대상 계정·리전·workspace, 실제 plan 증거, README-aws와 단계별 운영 보고.
state/plan 원문에 비밀값이 있을 수 있으므로 전체 출력·공유 대신 최소한의 비밀 제거 요약을 쓴다.

## 절차

1. 현재 단계를 확정한다. T4 감사를 T9까지 구축된 것처럼 평가하지 않고 후속 항목은 NOT_APPLICABLE로 구분한다.
2. 실행 루트별 fmt -check, validate 결과를 확인한다. init이 필요하면 기존 설정을 확인한 실행 담당만 수행한다.
   init -backend=false 구문 검사와 실제 backend plan을 구분한다.
3. 승인된 환경의 terraform plan -detailed-exitcode를 실행 담당에게 요청한다.
   0=변경 없음 성공, 2=변경 있음 성공, 1=오류. plan 미실행에 생성 수 0을 쓰지 않는다.
   삭제·교체, 기존 DB/EBS·상태·백업 영향, 예상 밖 drift를 개별 검토한다.
4. 서비스 SG 체인과 SSM·로그·패키지 공급 경로를 각각 확인한다.
   공개 인바운드 0.0.0.0/0·::/0, 광범위 허용 우회, 불필요한 egress,
   EC2 퍼블릭 IP, SSH/배스천, DB의 IGW/NAT 경로가 없는지 검사한다.
   퍼블릭/앱 라우트의 기본 경로를 공개 인바운드와 혼동하지 않는다.
5. 시크릿의 전체 흐름을 추적한다: SSM 이름/ARN → runtime IAM → 프로세스 주입.
   data source·변수·user_data·출력·plan/state·cloud-init/로그에 값이 들어가지 않는지 확인한다.
   민감 표시(sensitive)와 실제 상태 저장 방지는 다르다. 복호화해서 스캔하지 않는다.
6. IAM의 Action/Resource·Endpoint 정책·KMS 필요 권한·키별 접근 범위를 확인한다.
   광범위 Allow에 좁은 Allow를 추가한 것을 권한 축소라고 보지 않는다.
7. DB 볼륨 초기화 멱등성·재부팅·backup/restore 준비·chrony·SSM·cloud-init 실패 감지를 검토한다.
   스크립트 존재와 실제 부트스트랩/복구 성공을 구분한다.
8. T7 이상이면 10대의 키/UUID/outbox 매핑과 실제 CloudWatch/DB 유입 증거를 확인한다.
   T9이면 외부 ALB의 정적·metrics GET 허용과 정확한 적재 경로/default 404 증거를 확인한다.
9. 비용은 최신 공식 단가와 계정·리전·시간·구성 기준으로 산출하거나 미확인으로 표시한다.
   NAT/공인 IPv4, ALB/LCU, Endpoint 서비스×AZ, EC2/EBS, snapshots/S3, logs, 데이터 전송을 구분한다.
   후속 단계 비용을 T4 신규 비용에 혼합하지 않는다. 태그 지원 예외는 기록한다.
10. 상태 버킷·시크릿·DNS/인증서·백업 중 재현 전에 유지할 자원과 destroy 대상 자원을 구분한다.
    15분 범위와 최초 준비 단계를 사람이 확정했는지, 실제 리허설 증거가 있는지 확인한다.
    이 감사는 apply/destroy 리허설을 직접 실행하지 않는다.

## 완료 보고

검증 표와 High/Med/Low 발견 목록, plan 생성·변경·삭제·교체 요약,
비용 산식과 가정, 수용/수정/사람 결정 판정, 미검증 운영 항목을 보고한다.
‘plan 리뷰 수용’은 ‘AWS 적용/연결/복구 검증 완료’와 다르다.

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