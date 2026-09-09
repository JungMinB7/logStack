# T5 DB 인프라 — 로컬 코드와 검증 인계

**최신 재개는 §8이다. §1~7의 미확정값·custom AMI 우선·검증 결과는 이전 부분 구현 이력으로 보존한다.**

2026-09-09 KST. **T5 일부 로컬 코드 작성 / 실제 전체 plan BLOCKED / runtime 미배포**.
T5 완료 조건인 receiver→DB psql 접속은 유지한다. T6 receiver가 없고 이번에는 AWS 적용을 승인하지 않았다.
T4의 생성60개 plan·독립 수용은 과거 기준선이며 T5를 포함하지 않는다. 이전 plan을 현재 소스에 적용하지 않는다.

## 1. 이번 권한·현재 인수

- 시작 `/Users/ljm/Desktop/logStack`, `main`, HEAD `f853c2159f3ce574b3c1919d1138625fd5abac5f`, staged/unstaged/untracked 없음.
- 최신 T5 사용자 요청과 `t5-db-infrastructure` 절차를 직접 읽어 사용했다. 이전 infra/AGENTS의 T4-only 제한에 대한 이번 T5 로컬 작성 예외이며 AWS 변경 허가가 아니다.
- 메인 `/root`는 입력·읽기 전용 AWS 확인·가격·리뷰 조율. 실제 infra-developer `/root/t4_execution`은 infra 유일 작성자. `/root/t4_final_review`는 구현 미참여 독립 읽기 전용 **default 일반 에이전트 대체 역할**이며 등록 infra-reviewer 호출 성공이 아니다. 하위 재위임·설정/전역 권한 변경 없음. 감사는 infra-audit 체크리스트를 사용하며 T4 결과를 T5 수용으로 재사용하지 않는다.
- 도구 재사용: `/Users/ljm/.local/share/terraform/1.14.9/terraform`, AWS CLI `/Users/ljm/.local/share/aws-cli/aws` 2.36.40. AWS provider 6.63.0, 양 root lockfile 유지. 재설치·upgrade·backend 재구성·workspace 변경 없음.
- 기존 T4 소스 14개/주소·state·metadata·provider lock·입력·T3 증거를 보존한다. 추가 DB 코드는 **기존 runtime 실행 루트**의 data subnet/db SG/DB instance profile을 직접 참조한다.

메인의 이번 실제 읽기 전용 확인 인수(이 작성자가 재실행한 AWS 결과 아님; 메인 tool results에 보존, 별도 ignored 로그 없음): STS 최초 sandbox 접속 실패 exit255 후 정식 승인 재시도 exit0, 계정324037288068 / `user/jungmin-logstack` 일치. 프로파일 `logstack-t4`, 서울.
S3 exact runtime prefix 현재 KeyCount0, IsTruncatedfalse 및 Project=logstack-demo VPC 조회 `[]` 각각 exit0으로 runtime 미배포 인수와 일치.
backend metadata S3/logstack-bucket/runtime/terraform.tfstate/서울/encrypt=true/use_lockfile=true/allowed_account_ids=[324037288068], default workspace 확인 exit0.
자기 소유 AMI 조회 `[]` exit0: 준비 이미지 없음이 아니라 **해당 조회 범위에서 없음**, 공유 이미지·패키지 manifest는 미확인이다.
프로세스 목록 조회는 sandbox `zsh:1: operation not permitted: ps` exit1로 미확인, 우회 권한 확장하지 않았다.

## 2. 상태와 T4 증거 보존

실제 bootstrap 리소스 상태는 `/Users/ljm/Desktop/logStack/infra/bootstrap/terraform.tfstate`다.
메인 이번 확인: owner ljm, mode0600, 9321 bytes, 수정2026-09-09 03:35:55 KST, SHA256
`b20090b65ccef7a62a112db0282fd3d81016ab09661dc992456ae11984d7ef9a` (이전과 동일).
`.terraform/terraform.tfstate`는 backend metadata이며 리소스 상태 백업이 아니다.
별도 암호화·접근 통제 보관 장소/백업 존재는 **미확인**. 같은 디스크 `.backup` 또는 runtime S3 버킷만으로 완료라고 하지 않는다.

사람용 절차: 외부 암호화 보관 위치를 먼저 정하고, 정확한 원본과 계정/권한을 확인한다. 아래 변수의 목적지는 사람이 입력하며 현재 승인 경로가 아니다.

```sh
umask 077
task_state=/Users/ljm/Desktop/logStack/infra/bootstrap/terraform.tfstate
read -r 'task_backup?사람이 승인한 암호화된 별도 보관 파일의 절대 경로: '
# 목적지가 별도 암호화 보관소인지 사람이 확인. 빈 값/기존 파일/심볼릭 링크면 중단.
test -n "$task_backup" && test ! -e "$task_backup" && test ! -L "$task_backup" || return 1
cp -n "$task_state" "$task_backup" || return 1
chmod 600 "$task_backup" || return 1
cmp -s "$task_state" "$task_backup" || return 1
shasum -a 256 "$task_state" "$task_backup"
stat -f '%Su %Sp %z %Sm %N' "$task_state" "$task_backup"
```

실제로 복사/업로드하지 않았다. 원본 이동·삭제 및 runtime key로 복사/migrate 금지. 완료 시 사람이 보관 시각/권한/지문만 기록하며 state 내용은 공개하지 않는다.
기존 runtime plan 경로 `infra/.terraform/t4-runtime-plan-20260909/runtime.tfplan`, SHA256 `90cc748a946708c986792a4a87e6a4faf7c5f77f1e8e18d9505cec80a884a28a` 유지. T5 새 plan 파일은 아직 없다.

## 3. 입력·사람 결정 (한 번에 요청, 값/비밀번호/비밀 해시 요청 아님)

| ID | 현재 근거·상태 | 선택/권고 및 필요한 실제 값 | 승인 후 후속 작업 |
|---|---|---|---|
| T5-I1 | DB 타입/AZ/AMI 미확정. 사전 준비 AMI 우선만 승인 | t3.medium + data_a + credit Standard는 권고. 실제 타입/subnet, AMI ID·owner·OS 버전·architecture, 비밀 없는 제작기록/manifest 필요 | db 입력 확정, 이미지 공급 기록. 다른 family 지원은 코드 재검토 |
| T5-I2 | gp3/encryption 요구, 용량·성능·수명주기 미정 | root20GiB/data100GiB, 각각3000IOPS/125MiB/s 권고. 암호화 키 ARN 또는 명시적 AWS 기본키 선택. 첫 빈 볼륨 초기화/보존/재연결 승인 | db 변수, 보존 runbook. root 성능도 필수 변수 |
| T5-I3 | PG16·SSM·chrony 사전 공급, 실제 이미지 없음 | systemd/Nitro NVMe/ext4/Python3.9+/AWSCLI/PG16/util-linux/e2fsprogs/chrony/SSM/cloud-init 지원 계약 제안. vendor PG 자동 기동·기존 cluster 없는 이미지 | 제작 주체·OS·도구 버전 검증 후 manifest 고정. builder/AMI 생성은 별도 승인 |
| T5-I4 | DB명/권한/SSM/KMS 미정 | migration owner + runtime DML 2역할은 제안. 두 이름·DB명·정확 SecureString ARN·KMS 키 권한 필요. 비밀번호는 사람이 SSM에 준비, 코드 지원 범위 ASCII printable16~1024자 | 정확 DB GetParameter IAM + SSM Endpoint 양쪽 허용. KMS Decrypt 정책. T6 별도 migration/runtime DATABASE_URL 주입 |
| T5-I5 | dump/snapshot 목적지·주기·보존·주체 미정 | 별도 bucket/prefix/owner, AES256 또는 KMS, 시간/보존·복구목표. 스냅샷은 사람/외부 스케줄러/DLM 비교 필요 | S3 PutObject IAM/Endpoint/DB egress, 필요 KMS, timer/retention, snapshot executor. 상태 버킷 재사용 금지 |
| T5-I6 | Logs endpoint Deny·로그 IAM 없음 | PG/systemd/cloud-init/backup/SSM 중 수집대상, 그룹 ARN·기간·실패 알림 방식 | 정확 Logs 권한과 Endpoint 변경, AMI 수집 agent/설정. 세션 preferences/KMS도 별도 확인 |

`runtime/db.tfvars.example`은 실제값 없는 입력 형식이며 plan용이 아니다. 기존 ignored terraform.tfvars/backend.hcl은 변경하지 않았다.
기본값이나 `enable=false`로 DB를 빼지 않는다. 필수 db 객체 외에도 `local.db_integrations_ready=false` 하드 precondition으로 미구현 권한·백업·로그 연결 상태에서 plan 성공/배포를 방지한다.
값만 채워 gate를 임의 해제하면 안 된다. 승인된 통합 구현·검증·독립 리뷰 후 코드 변경으로 해제한다. T4 우선 apply를 강제하지 않는다.
계획/설계 문서의 역할·백업 정책 보완이 필요하면 메인이 승인 후 `plan-aws.md T5`, `docs/design-aws.md §6/7/9/12` 수정 여부를 조율한다. 이 작업에서 바꾸지 않았다.

## 4. 구현한 부분과 대기 부분

| 부분 | 로컬 구현 | 완료하지 않은 것 |
|---|---|---|
| EC2/storage | DB1 리소스, pinned AMI owner/id/arch, EC2 arch 교차검증, IMDSv2, public IP 없음, 기존 data AZ·db SG/profile, 별도 암호화 gp3 + attachment, 태그·output | 실제 AMI/packages, EC2/EBS 생성·attachment·성능 |
| 데이터 보호 | instance/data EBS/attachment prevent_destroy. user_data 변경은 교체 계획으로 표시하되 보호로 중단. 볼륨 ID→NVMe serial→전체 disk→root/다른mount/partition 거부 | 보호 해제·기존 volume 교체·복원 snapshot 인수는 사람 결정, 자동 state 이동 없음 |
| bootstrap | bounded attachment wait, signature 검사 후 명시 승인된 초기 mkfs.ext4, exact mount source/type/options 확인. root fallback 금지. marker·PG16/control header·기존 auto.conf 검사 | 완전한 모든 data page checksum 검사/실제 부팅·복구. 실패한 init의 자동 청소 없음 |
| PG/security | private Unix socket만 연 임시 서버에서 SSM runtime 조회→메모리 SCRAM→psql stdin. argv/파일/출력에 secret 없음, error text/SQL 반사 없음. 이후 정규 PG 서비스. UTC/UTF8/scram/원격superuser 차단 | 현재 SSM GetParameter IAM/Endpoint는 아직 거부. 앱 migration 실행 없음. DB TLS 추가 결정 없음(기존 내부5432 계약) |
| service/time | SSM·chrony Requires/After, Amazon169.254.169.123 선택·sync 검사, PG prepare 의존. 재부팅 시 mount/identity/PG16 확인 반복 | AMI native PG 자동 서비스/기존 data 없음을 manifest + runtime 검사. 실패 서비스 자동 중단·삭제 없음. SSM 연결 실측 없음 |
| pg_dump | 보호된 `.partial`→pg_restore 목록 검사→fsync/rename→정확 S3 PutObject→upload marker. 동시 flock, 실패 산출물/이전 성공 보존. 5GiB 이상은 보존 후 실패 | 스케줄/보존·S3 정책/키/버킷/경로 미정. `/etc/logstack-backup.json`·timer를 설치하지 않음. AES256 단일 PutObject 지원 초안만, KMS/multipart는 미구현 |
| snapshot/logs | 요구·선택·사람용 복구/보존 인계 | EC2 API 실행주체·주기·보존 선택 전 snapshot서비스/새Endpoint/추가권한 생성 없음. Logs 권한/수집도 미구현 |

T4 대비 현재 SG/route/IAM/Endpoint 소스 변경 **없음**. DB S3 egress 없고 S3 endpoint 빈 Deny 유지. SSM endpoint는 UpdateInstanceInformation만 허용하므로 IAM만 추가해도 secret 조회는 실패한다.
GetParameter WithDecryption의 KMS 호출은 SSM 측이며 이 흐름에 DB 직접 KMS Endpoint를 자동 추가하지 않는다. EC2 snapshot API는 현재 Endpoint로 도달하지 않는다.
태그 지원 DB/volume/root disk에 Project 적용. attachment·systemd/file는 AWS 태그 대상 아님.

## 5. 검증 증거

접근 제한 ignored `infra/.terraform/t5-local-20260909/` 사용(디렉터리0700, 로그0600). provider 다운로드/새 init은 불필요하여 하지 않았다.

| 검증 | 현재 결과·증거 |
|---|---|
| 35 mock tests | PASS exit0 `01-mock-tests.log`. 이후 렌더 추가 |
| fmt/check | PASS 각각 exit0 `06-final-fmt.log`, `07-final-fmt-check.log` |
| runtime/bootstrap validate | PASS 각각 exit0 `15-latest-runtime-validate.log`, `13-bootstrap-validate.log` 정식 도구 승인. 이전 `03/08` 성공 기록도 보존 |
| 실제 template 렌더 + 안전 mock | `04` exit1은 테스트 harness의 HCL escape 처리 결함. 수정 후 `05`와 최종 `09-final-render-mock-tests.log` **37 PASS exit0**. 콘솔은 빈 임시 디렉터리, provider/backend/plan 없음. missing-variable 거부·특수문자 round-trip·gzip 크기·bash -n/Python compile 포함 |
| ShellCheck | `command -v shellcheck` exit1, 미설치 NOT_RUN. 새 전역 설치 없음 |
| 전체 T5 실제 plan / JSON / 독립 plan 리뷰 | **BLOCKED** 입력/AMI/권한·백업·로그 미정. add/change/delete/replacement **미산출**, 0 아님. fake 값·target·refresh=false·mock provider·우회 backend 사용 없음 |
| AWS apply/DB initialization/SSM/backup/restore/receiver psql | **NOT_RUN** 권한 없음·runtime/receiver 미배포 |
| 앱 lint/build/unit | PASS 각각 exit0 `10-app-lint.log`, `11-app-build.log`, `12-app-test.log` (3 suites/12 tests). 앱 소스 수정 없음 |
| e2e | **NOT_RUN** 격리 환경 미확인. test/metrics.e2e-spec.ts56~57 및 ingestion.e2e-spec.ts125~126 deleteMany로 기존 DB 변경 위험. T3 소크/통합도 재실행하지 않음 |

최종 코드/예시/테스트·기존 lock·bootstrap state·T4 plan 지문은 `14-code-evidence-manifest.log` (2026-09-09T05:13:04Z)에 기록했다.
기존 T4 14개 tf/양 lock 및 범위 밖 src/sender/scripts/test/package/설정/명세 diff는 exit0 무변경. git diff --check/cached --check exit0. add/commit/push 없음.
독립 리뷰 `/root/t4_final_review`는 현재 코드·37개 테스트·양 root validate·14의16개 SHA 및 최종 §5를 직접 대조하여
**hard gate를 유지한 T5 부분 로컬 코드·정적 검증·인계 문서를 수용, 미해결 High0/Med0/Low0**로 판정했다.
기존 marker+pgdata 소실 시 initdb 위험(Med1)은 수정과 안전 shell mock 회귀로 해소했다.
이 수용은 T4 결과 재사용이나 실제 T5 plan 수용이 아니다. 전체 plan/JSON/plan 독립 리뷰는 BLOCKED이며,
통합 구현·운영 준비·T5 전체 완료를 의미하지 않는다. 승인 후 통합 코드와 새 전체 plan의 독립 재검토가 필요하다.

## 6. 사람이 실행할 운영·복구 인계 (이번 실행 아님)

1. 이미지: 신뢰 가능한 제작자가 승인 OS/architecture에 PG16·도구를 준비한다. vendor 자동 PG 서비스 disabled/masked, 기본 cluster 없음, AMI에 secret/사용자 AWS credentials/기존 PGDATA 없음. chrony는 Amazon Time Sync만 사용. manifest 예시를 실제 버전·build record로 채워 root 소유/쓰기 제한 `/etc/logstack-image-manifest.json`에 두고 비밀 없는 manifest SHA256을 승인받는다. OS/패키지 확인과 metadata만의 검증을 구분한다. 현재 builder/이미지 제작은 실행하지 않는다.
2. 최초 볼륨: 정확 volume ID·AZ·원본 데이터 없음 및 allow_blank_volume_init 승인을 확인한다. marker 생성 뒤 init 실패/부분 데이터/marker만 있고 pgdata 없음은 재부팅해도 자동 초기화하지 않고 실패한다. 기존 PG16은 initdb하지 않는다. stale postmaster.pid는 삭제하지 않고 pg_ctl/Postgres의 안전 판단에 맡긴다. 다른 major/unknownFS/partition/foreign mount/auto.conf override는 데이터 보존 상태로 중단한다.
3. 정상 기동: `systemctl status logstack-db-prepare logstack-postgresql`, AMI의 SSM/chrony unit, `journalctl -u logstack-db-prepare -u logstack-postgresql`, cloud-init status를 사람이 승인 대상에서 확인한다. private bootstrap log는 `/run/logstack-db-private/bootstrap.log`(보호·휘발)이며 비밀값·verifier·SQL·원본 로그 전체를 채팅에 복사하지 않는다. `PG_VERSION=16`·실제 mount ID·chronyc source/sync·pg_isready·SSM 세션을 각각 증거화한다. 정상 서비스 실행 중 backup verify는 TCP listener를 거부하지 않고 mount/identity/PG16만 확인한다.
4. T6 migration: 현재 `src/database/data-source.ts` DATABASE_URL, synchronize=false 유지. 최초 role/DB 생성과 스키마 생성은 별개다. 승인된 migration owner DATABASE_URL로 기존 `npm run migration:run`을 실행하고 runtime은 DML 역할 URL을 주입한다. 기존 `1757310000000-Init.ts`의 2테이블/인덱스/FK/CHECK가 단일 원천. 별도 DDL 복제 없음. receiver→DB psql 및 최소 SELECT, runtime CREATE/DROP 거부와 INSERT/조회 권한 검증은 T6에서 별도 승인 후 수행한다.
5. dump: 주체/주기·별도 버킷/prefix·retention·암호화 승인 뒤 정확 정책/egress와 timer를 구현하고 새 plan 리뷰한다. 스크립트의 upload marker는 API 성공이지 restore 성공이 아니다. 실패 `.partial`/`.dump`와 마지막 성공은 유지하며 디스크 적체 경보·정리 주체/보존 기간을 정하기 전 자동 삭제하지 않는다.
6. restore: pg_dump는 역할을 포함하지 않는다. 비밀 제외 role 정의/소유권·DB 생성 계약을 별도 인수하고 사람의 SSM runtime 주입으로 역할을 재구성한다. 승인된 **별도 복구 대상**에 dump를 내려받아 `pg_restore --exit-on-error`로 복원, 원본 DB에 덮어쓰지 않는다. roles/default privileges/owner/migration 이력·행수·핵심 제약·UTC 조회를 비교하고 receiver 재연결까지 검증한다. dump 목록 검사만으로 복원 완료라고 하지 않는다.
7. snapshot: 단일 PGDATA 볼륨 내 WAL 포함 여부를 확인한다. 쓰기 중 EBS snapshot은 crash-consistent일 수 있으며 앱 수준 트랜잭션/복구 성공을 의미하지 않는다. quiesce/체크포인트/외부 스케줄러 정책과 복구 RPO/RTO를 별도 승인한다. 복원 snapshot의 새 volume ID는 현재 marker와 달라 자동 재연결되지 않는다. 정확 원본/복원 관계·AZ·PG major를 읽기 검증한 뒤 명시적 복구 절차를 별도 구현/리뷰한다. 자동 mkfs/marker 변경/state 조작으로 우회하지 않는다.
8. EC2 교체: user_data/AMI 교체는 prevent_destroy로 중단한다. 별도 승인하에 마지막 백업·복구 증거와 DB 정상 종료·볼륨 분리/재연결 계획을 검토하고 보호 전환·새 전체 plan을 승인받는다. force_detach=false 유지, 동시 attach/multi-writer 금지. root 삭제 가능과 data EBS 별도 보존을 혼동하지 않는다.

## 7. 비용과 진행 판정

메인 이번 공식 AWS Pricing API 조회(2026-09-09 KST, endpoint us-east-1 / 상품 regionCode ap-northeast-2, Linux/Shared/OnDemand; 전부 exit0):

| 항목 | 서울 단가 | 근거/적용 |
|---|---|---|
| t3.small | $0.026/h | SKU PZHVQ3KFPA3RHA5V. 48h $1.248 /72h $1.872 |
| t3.medium | $0.052/h | SKU G5CAZXC4M5ENHEZN. 48h $2.496 /72h $3.744, 아직 권고 |
| gp3 | $0.0912/GiB-month | SKU MTK7D9SGKGYR3JD6, root+data 합산 |
| gp3 초과 IOPS | $0.0057/IOPS-month | SKU65V6R2HKUXFQ5VRV, baseline 초과분 |
| gp3 초과 throughput | $0.0456/MiBps-month | SKUQ48V7C4BM3UCSZMQ, $46.6944/GiBps-month 환산 |
| EBS snapshot | $0.05/GB-month | SKUJC4HQPKR4ATMSY93, 실제 저장 증분량 미측정 |

공식 출처: [EC2 On-Demand](https://aws.amazon.com/ec2/pricing/on-demand/), [EBS 가격](https://aws.amazon.com/ebs/pricing/), [DLM 수명주기](https://docs.aws.amazon.com/ebs/latest/userguide/snapshot-lifecycle.html).
권고 예시만: t3.medium + root20/data100GiB + baseline gp3, 월720h 환산 →48h $3.2256 /72h $4.8384.
Standard credit는 초과 credit 과금 대신 고갈 시 성능 제한, Unlimited는 credit 비용 추가 가능하다. 승인·견적 상한 아님.
T4 NAT/EIP/Endpoint 비용은 기존 별도다. snapshot/AMI backing storage/S3 dump·요청·버전/CloudWatch/KMS/전송/세금/초과 credits/종료 후 잔존 비용은 위 예시에 제외되어 있다. 실제 backup 용량·보존 미정으로 합계 확정 불가.

**진행 판정: 독립적인 T5 소스·정적 검증 진행, 통합 설계/입력 확정 후 실제 전체 plan·독립 재검토 필요. T5 전체 완료 아님.**
runtime apply는 보류이며 에이전트는 실행하지 않는다. T6/7/8/9를 자동 시작하지 않는다. bootstrap 별도 상태 백업은 병렬 운영 인계로 남기며 로컬 코드 작업 차단과 혼동하지 않는다.

## 8. T5 결정 보완·AL2023 검증 재개 (2026-09-09 KST)

사용자 최신 요청 `098fd96b-db52-482a-970f-cfbec0205eae/pasted-text.txt`를 직접 읽고 기존 구현에서 이어간다.
시작 main/HEAD f853c2159f3ce574b3c1919d1138625fd5abac5f, 기존 T5 16개 파일은 **staged** 상태였다.
staged 변경을 보존하고 add/unstage/commit/push/브랜치 변경은 하지 않는다. 이 절의 새 수정은 아직 staged하지 않았다.

### 이번 승인과 실제 입력

- 승인값: t3.medium, 공식 Amazon Linux2023 x86_64, root gp3 20GiB/data gp3 100GiB,
  AWS managed EBS key 우선, gamelogs/logstack_app, PG16/UTC, Amazon Time Sync,
  receiver SG에서만5432·원격superuser/SSH/public IP 금지, pg_dump 하루1회, snapshot 하루1회 목표.
- 설치 방식은 **공식 AL2023 + 기존 S3 Gateway를 통한 지역 repository + user_data PG16 설치**로 채택했다.
  메인의 공식 자료·읽기 전용 확인에 근거하며 실제 EC2 부팅/설치 성공은 미실측이다. custom AMI는 필수 선결 조건이 아닌 공급 실패 시 대안이다.
  빌더/AMI 생성·임시 인터넷 경로는 승인하지 않았다.
- 사용자가 모든 제안을 승인하여 `/logstack/demo/db/application-password` 및 `/logstack/demo/db/migration-password` 기존 두 경로를 유지한다. 앱 역할 logstack_app/migration owner logstack_migrator를 분리한다. 새로운 app-password Parameter는 만들지 않는다.
- 동일 승인으로 DLM 일일 data snapshot/최근3개, 전용 S3 `logstack-db-backup-324037288068-ap-northeast-2/pg-dump/`/SSE-S3/공개차단/7일 보존과 일일 dump를 확정했다. data_a, CPU Standard, 각 gp3 3000IOPS/125MiB/s, 삭제 보호도 명시 승인됐다.
- 실제 ignored `runtime/terraform.tfvars`에 비밀 없는 승인값을 추가(mode0600). root/data KMS는 계정 default를 추측하는 null 대신 확인된 AWS managed EBS key ARN `arn:aws:kms:ap-northeast-2:324037288068:key/f6ed82b3-880c-46c9-a2fc-d5e77e71e80c`로 고정했다.

### 독립적으로 승인된 SSM 코드 보완

`runtime/iam.tf`에 DB role만의 `aws_iam_role_policy.db_parameters`를 추가한다.
Action은 **ssm:GetParameter 하나**, Resource는 `var.db.migration_secret_arn`과 `var.db.application_secret_arn` 정확 두 ARN이다.
`runtime/endpoints.tf`의 기존 SSM Endpoint에 같은 두 ARN·DB role ARN 조건만 추가하며,
기존 관리 channel·sender/receiver 권한은 유지한다. receiver의 비밀번호 조회 권한은 T6에서 별도로 승인한다.
Parameter 값 data/resource, GetParametersByPath/History, PutParameter, 새 KMS Endpoint, 새 키를 추가하지 않는다.
사용자 승인·구현 보완 후 메인 승인대로 무조건 false gate를 고정 AMI/release·DB/볼륨/역할/키 precondition 및 IAM/Endpoint/backup/DLM 의존성으로 대체했다.
CloudWatch 원격 수집은 T6 미구현 인계로 명시하고 Logs Endpoint Deny를 유지한다. 실제 plan 성공을 위해 DB를 제외하거나 검증을 생략하지 않는다.

### AL2023 공식 확인 근거 (메인 실제 읽기 전용 결과 인수)

- AWS describe-images owner=amazon: `ami-080417beadd39ca40`, owner137112412989,
  `al2023-ami-2023.12.20260831.0-kernel-6.1-x86_64`, creation2026-08-26T15:34:32Z, root `/dev/xvda`.
  고정 release `2023.12.20260831`; most_recent 선택 없음.
- 공식 mirror GET은 서울 bucket `al2023-repos-ap-northeast-2-de612dc2`에서
  `core/guids/85f850e94b099c03219caec40bfba27b4d5a4f494da0cecd49502a9ad5cd201e/x86_64/`를 반환했다.
  primary.xml.gz SHA256 `46caf3c3f7d0089b31c5b7c3520d8c9289495bed68523451059d79d82647ce73` 확인.
  repomd.xml.asc GET 성공863bytes는 서명 파일 존재 증거이지 이번 머신에서의 서명 검증 성공이 아니다.
- PG16/client/server/private-libs16.15-1.amzn2023.0.1, chrony4.3-1.amzn2023.0.6,
  amazon-ssm-agent3.3.4624.0-1.amzn2023, awscli-2 2.33.15-1.amzn2023.0.1을 고정한다.
  서버 RPM SHA `80e77f81906db186faa930b4e8e39b26e85422bcf27be89d857f38ab02e6e852`와
  `/usr/bin/initdb,pg_ctl,pg_controldata,postgres,postgresql-setup`, native postgresql.service/PGDATA=/var/lib/pgsql/data를 실제 archive 읽기로 확인했다. RPM은 실행하지 않았다.
- RPM 경로는 **bucket root blobstore/**다(core/blobstore 아님). Endpoint는 고정 GUID metadata + 이 공식 bucket의 blobstore/ GetObject만 허용한다.
  종속성 공급에 필요한 범위로 구현했으며 blobstore의 모든 패키지 blob을 포함한다. 이는 메인이 승인된 공식 repository 공급 범위에서 판단한 구현 경계이며 사용자가 blobprefix만 별도로 승인한 것으로 표현하지 않는다. DNF unsigned GET이므로 IAM PrincipalArn 조건을 쓰지 않는다. 다른 bucket/List/Write 권한은 없다.
- user_data 설치는 fixed baseurl/release/top-level NEVRA, weak deps off, IPv4, TLS 검증, RPM gpgcheck=1와 repo_gpgcheck=1, skip_if_unavailable=False다.
  system-release가 제공하는 `/etc/pki/rpm-gpg/RPM-GPG-KEY-amazon-linux-2023`를 사용한다.
  설치 전 native postgresql.service/postgresql@.service를 mask하고 기존 PG process/기본 cluster가 있으면 중단한다. vendor init wrapper로 root PGDATA를 초기화하지 않는다.
  최초 설치 marker 후 재부팅에는 RPM/OS/서비스만 검사하고 dnf 재실행·업그레이드하지 않는다. 설치 실패가 PG/타이머/cloud-init 성공으로 덮이지 않게 단일 fail-fast runcmd를 사용한다.
- 실제 두 Parameter는 SecureString/alias/aws/ssm으로 metadata 확인했다. 해당 AWS 관리 key와 alias/aws/ebs는 Enabled/KeyManager=AWS 확인. 실제 시크릿 값은 읽지 않았다.
  전용 backup bucket HeadBucket은404 NotFound(exit254)로 확인했으며 글로벌 이름 예약/생성 성공 보장은 아니다.

공식 근거: [AL2023 repository 관리](https://docs.aws.amazon.com/linux/al2023/ug/managing-repos-os-updates.html),
[AL2023 release package 비교](https://docs.aws.amazon.com/linux/al2023/release-notes/vercmp-AL2023.11-AL2023.12.html),
[AWS repository 연결](https://docs.aws.amazon.com/mgn/latest/ug/Troubleshooting-Communication-Errors.html).
기본 설치 방식은 공식 메타데이터·RPM·네트워크 계약 수준에서 성립한다. **데이터 subnet에서의 DNF·GPG·전체 dependency closure 설치는 사람 apply 뒤 검증 대상**이다.

### Snapshot 비교와 채택 범위

| 방식 | IAM·네트워크·추가 리소스 | 비용/침해 범위/잔존 | 일일 목표 |
|---|---|---|---|
| A DB 자체 호출 | DB CreateSnapshot/Delete 권한, 격리 subnet에서 EC2 API Endpoint 추가 필요 | Endpoint 고정비 및 DB 침해 시 snapshot 권한 노출, 잔존 별도 관리 | timer까지 있어야 충족, 미채택 |
| B 외부 관리 주체 | 운영자 또는 별도 scheduler 역할/API 경로 | DB 권한은 작으나 외부 실행 주체 관리·과금/보존 책임 추가 | 스케줄러 승인 필요, 일반 대안 |
| C 사람 runbook | 운영자 exact volume snapshot 권한, DB Endpoint 추가 없음 | 추가 관리 고정비 최소, 매일 사람 실행·삭제 책임 | 일일 자동 목표 충족 안 함, 수동 복구 보완만 |
| D **DLM 채택** | 별도 service-only 역할, 단일 data volume policy/24h/retain3, DB EC2 API 권한·새Endpoint 없음 | DLM 자체 추가 요금 없음, snapshot 저장비; DB 침해로 API 삭제권한 추가 안 됨. 정책/원본 삭제 후 잔존 별도 확인 | 일일03UTC 뒤 서비스 실행 창, 실제 성공 미검증 |

DLM CreateSnapshot은 정확 source volume + 서울 snapshot ARN(계정 부분 공란)/ParentVolume 조건,
CreateTags는 ParentVolume+Owner, DeleteSnapshot은 여기에 BackupPolicy/Project resource tag 조건으로 제한한다.
service-only trust+same account/Seoul SourceArn, 사람의 exact PassRole이 추가 경계다. DLM의 원자 tagging/후속 CreateTags 호출 순서는 공식 문서에서 보장되지 않아 CreateAction 필수 조건으로 가정하지 않았다.
잔여 권한: DLM 역할은 같은 볼륨의 기존 snapshot 태그를 바꿀 수 있다. 일반 DLM 역할의 Events 기능 전체가 이 단일 VOLUME 정책에 필요한지는 실측하지 않았으며 광범위 Events 권한을 추가하지 않는다.
실제 DLM 역할/API 호환성은 첫 snapshot 작업의 성공/오류로 확인해야 한다. VOLUME snapshot은 application-consistent/restore 성공을 보장하지 않는다.
근거: [EC2 IAM 조건](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html), [DLM 구성 요소](https://docs.aws.amazon.com/ebs/latest/userguide/dlm-elements.html).

### 현재 검증·변경·다음 gate

ignored `infra/.terraform/t5-al2023-20260909/`(0700/0600) 사용. 기존 backend/lock/default workspace와 staged16개/T4 증거 유지.

| 실행 | 결과·근거 |
|---|---|
| fmt / 최종 check | `04-approved-fmt.log` exit0 / 최종 태그 보완 후 `14-final-tag-fmt-check.log` exit0 |
| runtime validate | `07` exit1: DLM description의 세미콜론이 provider 허용 문자 밖. 설명 수정 후 `13` exit0, snapshot Environment 태그 보완 후 **15-final-tag-runtime-validate.log exit0** |
| 안전 render/mock | `05`47 PASS, cloud-init 실패 전파 수정 후 **11-failfast-mock-tests.log 48 PASS exit0**. 실제 렌더 runcmd를 systemctl mock으로 검증; 실제 설치/DB/서비스 실행 없음 |
| 앱 lint/build/unit | `8-app-lint.log`, `9-app-build.log`, `10-app-test.log` 각각 exit0. unit3 suites/12 tests |
| e2e·T3 soak | NOT_RUN 기존 DB deleteMany/격리 미확인. 과거 결과를 이번 결과로 쓰지 않음 |
| 정상 init / 새 실제 전체 plan / JSON / 독립 plan 리뷰 | **BLOCKED** 메인 AWS 조회 중 ExpiredTokenException(exit254), 재로그인 대기. 반복 실패/우회 없음. add/change/delete/replacement 및 T4대비 실제 수량 **미산출** |
| AWS apply·DB 설치/초기화·SSM·dump/snapshot/restore·receiver psql | NOT_RUN. T5 완료 조건/T6 연결 검증 유지 |

이번 변경은 기존 runtime DB 보완 및 신규 db-repository.tf/db-backup.tf/db-snapshots.tf, installer/repo/service/timer·안전 테스트,
T5_STATUS/README/TEARDOWN 인계다. T4 IAM/SSM·S3 Endpoint와 DB S3 egress가 승인 범위에서 바뀌었으며
VPC/subnet/route/NAT/서비스SG 체인·기존 주소는 보존한다. plan-aws/design-aws 최소정정은 메인이 단독 작성했다.
최종 코드·실제 입력·lock·bootstrap state·T4 plan 지문은 `16-final-code-input-evidence-manifest.log`에 기록했다.
bootstrap state/T4 plan SHA는 §2와 동일하다. staged16개를 변경하지 않았고 git diff --check/cached --check 및 앱·규칙·API 범위밖 diff는 exit0이다.
독립 `/root/t4_final_review`(기존 default fallback, 등록 infra-reviewer 호출 성공 아님)는 코드/문서·48 tests·최종 fmt/validate·앱12tests·16 manifest36항목을 읽기 전용으로 대조하여
**이번 AL2023 T5 코드·정적 검증 산출물을 범위 제한 수용, 잔여 High0/Med0/Low0**로 판정했다.
cloud-init PG 실패 소실 Med는 fail-fast와 실제 렌더 mock으로, DLM snapshot Environment 태그 누락 Low는 태그 보완/재검증으로 해소했다.
리뷰어는 파일 수정·Terraform/AWS 실행을 하지 않았다. **새 실제 전체 plan 및 독립 plan 리뷰는 인증 만료로 NOT_RUN/BLOCKED이며 생성·변경·삭제·교체 수량은 미산출**이다.
runtime 미배포, 실제 설치·SSM·백업/복구·receiver 접속 미검증을 유지한다. 이전 T4 생성60개를 현재 총수나 새 plan 수용으로 재사용하지 않는다.

현재 필요한 사람 작업은 `aws login --profile logstack-t4 --region ap-northeast-2` 재실행이다(도구 절대 경로는 §1).
그 뒤 STS 계정·backend/workspace를 재확인하고 정상 init/전체 saved plan→JSON/SHA·T4 주소/속성 비교→독립 plan 리뷰를 새로 수행한다.
아직 apply하지 않는다. bootstrap 원본 상태와 별도 안전 백업 미확인은 §2를 유지하며 자동 복사/이전하지 않는다.

비용: 기존 서울 t3.medium+root20/data100 gp348h $3.2256/72h $4.8384 예시의 구성은 이제 승인됐다(월720h 환산).
메인 이번 Pricing 확인 S3 Standard 서울 첫50TB $0.025/GB-month(SKU3JSN7K7UDDNCYCDM, 2026-09-09, [공식 가격](https://aws.amazon.com/s3/pricing/)).
snapshot $0.05/GB-month는 §7의 앞선 공식 조회. DLM 자체 추가 요금과 저장비는 별개다.
S3 request 가격 새 조회는 인증 만료로 미확인. 실제 dump/snapshot 증분용량·전송·잔존일수·로그/세금 미측정으로 최종 금액 확정 불가.
S3 7일 lifecycle는 비동기 원격 만료이고 로컬 실패/성공 dump 자동 삭제는 없다. 디스크 점검/정리 책임과 retained volume/bucket/lifecycle/스냅샷 비용은 TEARDOWN §6을 따른다.
