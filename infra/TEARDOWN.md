# 데모 종료·보존·잔존 비용 인계

2026-09-09 현재: bootstrap은 사람이 적용했고 상태 버킷 logstack-bucket의 실제 존재·보호 설정을 확인했다.
bootstrap/runtime 저장 plan의 독립 검토를 진행했으며 runtime은 아직 적용하지 않았다. 최신 검증·수용 결과는 T4_STATUS.md §12를 따른다.
후속 T5는 승인된 AL2023 DB/EBS·S3 dump·DLM 코드 반영 상태이며 로그인 만료로 새 plan은 BLOCKED다([T5_STATUS.md §8](T5_STATUS.md)).
T4 저장 plan은 T5를 포함하지 않는다. DB 데이터 보호와 백업/로그의 잔존 조건은 아래 §6을 따른다.
아래는 실행한 삭제 기록이 아니다.
실제 리소스 생성 후 담당자가 목록을 채우고 사람이 전체 runtime 삭제 계획을 검토·실행한다.
48~72시간은 인프라 가동 계획이다. 종료 시각·완전 삭제 소요 시간·비용 0을 보장하지 않는다.

## 1. 삭제 전 데이터 인수

1. 계정 ID·프로파일·리전·runtime backend bucket/key·workspace를 대조한다. 다른 계정/상태면 중단한다.
2. AWS sender 생성 실행을 종료한다. 현재 로컬 Docker/DB/Claude/Node나 T3 증거는 대상이 아니다.
3. SIGTERM은 신규 생성을 멈추고 진행 중 응답 처리 후 종료하지만 전체 outbox drain을 보장하지 않는다.
   현재 sender는 USERS=0 또는 EVENT_RATE=0으로 새 프로세스를 시작하면 생성 없이 전송할 수 있다.
   T7 운영 절차에서 같은 UUID·키·OUTBOX_DIR을 유지하고 단일 writer만 사용한다. 무중단 설정 변경 API나 자동 종료 타이머는 없다.
4. receiver·DB·관리 Endpoint를 먼저 삭제하지 말고 최종 drain을 기다린다.
   독립 기록 성공 ID 집합 = DB 원본 ID ∪ 실패 저널 ID, 중복/교집합·누락·최종 pending을 검증한다.
   accepted 카운트나 429 발생만으로 무유실을 주장하지 않는다. 실패가 있으면 내용을 안전하게 인수한다.
   주의: 운영 main.ts에는 통합 테스트의 onRecorded 기반 독립 ID 수집기가 연결되어 있지 않다.
   T7/T8에서 생성 시작 전에 독립 기록 성공 집합의 수집·보존 방법을 별도 설계·승인받아야 한다.
   종료 후 이미 compact된 outbox나 검증 대상 DB에서 그 집합을 재구성해 독립 증거로 삼지 않는다.
5. 필요한 실행 로그·집합 비교·최종 스냅샷/덤프·설정 이름/버전 증거를 승인된 외부 보관 위치로 옮긴다.
   API 키·DB 비밀번호·plan/state 원문을 증거 공개물에 넣지 않는다. 보관 완료와 복구 가능성을 사람이 확인한다.

## 2. 소유권·수명주기 목록 (실제 ID 미확인)

| 대상 | 소유권/실제 ID | 기본 처리·확인 시점 |
|---|---|---|
| runtime VPC·서브넷·RT·IGW·SG·IAM | T4 생성 뒤 기입 | 전용 runtime이면 전체 삭제 계획에 포함 |
| Public NAT·EIP·Interface/Gateway Endpoint | T4 생성 뒤 기입 | NAT 삭제와 EIP 해제를 각각 확인 |
| EC2·ALB·임시 EBS | T5~T7/T9 뒤 기입 | 전용 여부·볼륨 보존 설정을 확인 후 runtime 계획에 포함 |
| T6/T9 전용 Alias·ACM 자원 | 레코드명·Zone ID·인증서 ARN 기입 | 프로젝트 전용 자원만. 공유 검증 레코드는 삭제 금지 |
| 상태 S3·bootstrap 상태/잠금 | backend 확인 뒤 기입 | runtime 삭제 제외. 안전하게 보존·접근 제한 |
| 기존 등록 도메인·public Hosted Zone | 소유권·Zone ID 기입 | runtime 소유로 import하지 않음. 기존 apex/www/MX/NS/TXT 보존 |
| 공유 자원·보존 SSM SecureString | 값 없이 ARN/소유자만 기입 | 별도 수명주기. 필요 시 보존 시크릿은 runtime 삭제 제외 |
| 자동 snapshot·AMI backing snapshot | snapshot/AMI ID·생성자·소유자 기입 | Terraform 밖 생성 여부 확인. 별도 보존 기간·삭제 승인 |
| S3 pg_dump·버전·복구 자료 | 버킷/접두사·보존 기간 기입 | 오래된 버전도 비용 대상. 전용 여부 확인 후 개별 승인 |
| CloudWatch 로그 | 그룹/보존 기간 기입 | retained 로그와 수동 생성 그룹을 별도 점검 |

Project 태그만으로 소유권과 삭제 승인이 증명되지 않는다. 광범위 태그 삭제·일괄 force_destroy·공유 자원 삭제 금지.
AMI deregistration과 backing snapshot 삭제는 같은 작업이 아니므로 남은 snapshot을 따로 추적한다.

## 3. 사람의 삭제 계획·실행

- 도구·인증·정확한 backend가 준비된 후 runtime 전체에 대해 사람이 삭제 plan을 생성·검토한다.
  코드와 infra/.gitignore는 준비됐다. 향후 사람의 실행 예: `terraform -chdir=infra/runtime plan -destroy -detailed-exitcode -out=teardown.tfplan`.
  현재 이 명령은 실행하지 않았다. runtime 디렉토리는 있으며 실제 backend/계정 검증은 대기다. 0/2는 성공, 1은 오류다.
- 생성/변경/삭제/교체 수와 각 주소를 확인한다. bootstrap 상태 버킷·기존 Zone·공유 자원·보존 자료가 포함되면 실행하지 않는다.
- agent는 plan 검토까지만 한다. 사람이 검토한 전체 runtime 계획을 적용한다. 임의 -target·-auto-approve는 사용하지 않는다.
  destroy/apply를 CLI/SDK/provisioner/terraform test로 우회하지 않는다.
- prevent_destroy·ALB deletion protection·데이터 보호 설정이 삭제를 막으면 정확한 대상 ID와 데이터 인수를 확인해
  사람이 별도 승인한다. 해당 보호 설정의 명시적 전환 후 새 전체 계획을 재검토한다.
  state rm/import/force-unlock·잠금 끄기·무단 backend 이전으로 보호를 우회하지 않는다.
- 부분 실패 시 AWS 실제 상태와 Terraform 상태를 읽기 전용 대조하고 오류를 기록한다. 넓은 범위 강제 삭제로 해결하지 않는다.

## 4. 종료 후 읽기 전용 확인

- NAT가 삭제됐는지와 EIP allocation이 해제됐는지를 별도로 확인한다. 유휴 EIP도 과금 대상이다.
- 외부/내부 ALB, Endpoint ENI, EC2, 남은 EBS, snapshot, AMI backing snapshot을 실제 계정·리전에서 확인한다.
- 전용 DNS·인증서의 정리와 기존 Zone/공유 검증 레코드 보존을 각각 확인한다.
- Terraform 밖의 dump·로그·스냅샷·수동 리소스는 정확한 ID/소유권 기준으로 보존 또는 별도 승인 삭제한다.
- 빈 runtime state만으로 잔존 리소스·비용 0을 선언하지 않는다. 청구 반영 지연도 고려해 사람이 비용 내역을 확인한다.
- 남길 자원의 지속 비용: 도메인 등록 갱신, 기존 Hosted Zone, 상태 S3/요청/버전, 보존 dump/snapshot/AMI/logs,
  선택한 KMS 키 등. 무료나 삭제 완료로 간주하지 않는다.
- 확인 날짜·계정·리전·리소스 ID·보존 책임자·재확인 시점을 단계 보고에 남긴다.

## 5. 재현

bootstrap 상태와 상태 버킷은 남긴다. 기존 도메인·Zone·필요 시크릿·승인된 AMI/공급 자료를 선행조건으로 확인한다.
반복 runtime 재생성은 사람이 수행하고 T8에서 실제 시간을 측정한다. 최초 설치·로그인·backend 준비를 포함해
15분 재현이 증명됐다고 쓰지 않는다. T3 로컬 소크 결과를 AWS 삭제/복구 증거로 재사용하지 않는다.

## 6. T5 데이터 보존·잔존 비용 (아직 미배포)

- DB instance/data EBS/attachment에는 prevent_destroy가 있다. user_data·AMI 변경도 instance 교체로
  계획되어 보호에 걸린다. demo 종료를 위해 자동 해제하지 않는다. 데이터 인수·복구 검증 뒤 사람이
  정확한 대상의 보호 전환과 새 전체 plan을 별도 승인한다. state 조작·force detach로 우회하지 않는다.
- root gp3는 instance 종료 시 삭제 가능하므로 영속 PGDATA를 두지 않는다. `/srv/logstack-db/pgdata`와
  local backup은 별도 data gp3이며 instance와 생명주기가 분리된다. 잔존 data EBS는 instance 정지/삭제 후에도
  용량·초과 IOPS/throughput 비용이 계속된다. 삭제 보호 자체는 백업이나 AWS 콘솔 강제 삭제 방어가 아니다.
- 승인된 DLM은 data volume만 일일03UTC(해당 시간 뒤 서비스 실행 창)/최근3개, dump는 일일02UTC 및
  `logstack-db-backup-324037288068-ap-northeast-2/pg-dump/` 미버전 버킷/SSE-S3/7일 만료다.
  현재 AWS 생성·스케줄 실행은 미실행이다. S3 실제 만료 삭제는 비동기이고 로컬 파일 만료가 아니다.
  DLM 정책 중지/삭제 또는 원본 volume 삭제 뒤 남은 snapshot은 Terraform destroy가 정리한다고 보장하지 않는다.
  실제 ID·소유자·복구 가능성·만료/보존 책임과 비용을 별도 인수한다. 상태 버킷은 dump 목적지가 아니다.
- 전용 dump bucket은 prevent_destroy=true/force_destroy=false다. 보존할 경우 bucket뿐 아니라 lifecycle,
  SSE/공개차단/ownership/TLS 정책 설정까지 유지하는 별도 승인 계획이 필요하다. 보조 lifecycle만 삭제하면
  남은 객체의 7일 만료 동작도 제거될 수 있다. 삭제 보호로 전체 destroy plan이 막히면 자동 해제하지 않는다.
  versioning은 이 단순 백업 버킷에 추가하지 않았다. 향후 versioning 도입은 noncurrent 보존까지 별도 결정한다.
- CloudWatch 원격 수집은 T6 미구현 인계다. 향후 retained 로그/AMI backing snapshot/수동 복구 자료도 별도
  비용·삭제 대상이며 승인 없는 강제 삭제/일괄 태그 삭제를 하지 않는다.
- dump 실패 `.partial`, 업로드 실패 `.dump`, 마지막 정상 백업은 자동 삭제하지 않는다. 보존 정책과 디스크
  적체 감시 책임자를 정하고 성공·복구 검증 전에 마지막 정상본을 지우지 않는다.
- snapshot 복원으로 새 volume ID가 생기면 기존 볼륨 marker와 다르므로 자동 시작을 거부한다.
  별도 승인된 복구 절차·원본/복원 ID·AZ·PG16/소유권 검증을 거쳐야 한다. 기존 볼륨을 mkfs하거나
  marker/state를 임의 변경해 연결시키지 않는다. 실제 EC2 교체·dump restore·snapshot recovery는 미실행이다.
- bootstrap 원본 로컬 state의 별도 암호화 보관은 여전히 미확인이다. T5_STATUS §2의 사람용 절차를 따르며
  runtime S3 state와 혼동하지 않는다. 원본/T4 plan/잠금 버전/실행 증거는 자동 정리하지 않는다.
