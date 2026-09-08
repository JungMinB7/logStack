# T4 Terraform 실행·입력 계약

2026-09-09 실행 검증 재개: 사용자 전용 Terraform/AWS CLI 설치, fmt/check, 양 root의 backend 없는 init/validate를 완료했다.
도구·정적 검증은 [T4_STATUS.md §10](T4_STATUS.md#10-t4-실행-검증-재개-2026-09-09-kst),
bootstrap plan 이력은 [§11](T4_STATUS.md#11-승인-입력으로-신규-bootstrap-실제-plan-2026-09-09-kst),
사람의 bootstrap 적용 인수·실제 runtime plan·현재 인계는 [§12](T4_STATUS.md#12-bootstrap-사람-적용-인수와-실제-runtime-plan-2026-09-09-kst)를 기준으로 한다.
프로파일 `logstack-t4`, 신규 상태 버킷 `logstack-bucket`, 향후 runtime key `runtime/terraform.tfstate`를 승인받았다.
bootstrap 실제 plan은 exit2, 6 add / 0 change / 0 destroy / replacement 0이며 사람이 상태 버킷 준비를 적용했다.
runtime 실제 S3 backend init·validate 성공 후 plan은 exit2, **60 add / 0 change / 0 destroy / replacement 0**이다.
양 root validate·실제 plan 독립 리뷰가 수용되어 **T4 구현·검증 완료**다. 최종 runtime 감사 High/Med/Low 각각0.
**runtime 미배포 / 사람의 적용 결정 대기**이며 AWS 연결·SSM·공급/로그·복구 실측 완료가 아니다. §12의 운영 인계를 유지한다.
정적 검증·실제 plan·사람 apply·AWS 실측은 별개다. 에이전트는 apply/destroy를 실행하지 않는다.

## 두 실행 루트

- `bootstrap/`: 기존 상태 버킷이 없다고 확인된 경우에만 사용하는 선택적 최초 준비 루트.
  로컬 backend로 새 S3 상태 버킷만 관리한다. 공개 차단·BucketOwnerEnforced·버전관리·SSE-S3·HTTPS 강제,
  `force_destroy=false`와 `prevent_destroy=true`를 적용한다. runtime 삭제 범위에 포함되지 않는다.
  기존 버킷을 bootstrap에 대입하거나 import하여 재소유하지 않는다.
- `runtime/`: 승인된 VPC·서브넷6·RT5·IGW·단일 NAT/EIP·서비스 SG5+vpce SG1·Endpoint·IAM 기반.
  VPC가 자동 생성한 default SG도 규칙을 비워 사용을 방지한다(추가 서비스 SG가 아님).
  코드의 `_c` 서브넷 key는 승인 표의 public-B/app-B/data-B이며 AZ c 후보에 대응한다.
  local main RT는 기본 local 경로만 남으며 서브넷6개는 모두 명시적 RT에 연결한다.
  EC2·ALB 본체·DB·DNS·인증서·시크릿은 아직 없다.

Terraform 제약 `>=1.10.0,<2.0.0`, AWS provider `~>6.0`은 유지한다. 실행 CLI는 Terraform 1.14.9다.
양 루트 실제 init은 HashiCorp 서명의 AWS provider 6.63.0을 설치하고 각각 `.terraform.lock.hcl`을 생성했다.
두 root의 init/validate는 정식 도구 승인 재시도에서 exit0이었다. sandbox DNS·provider 실행 실패도 §10에 보존했다.
기존 lockfile을 존중하며 `init -upgrade`를 자동 사용하지 않는다. 수제 lockfile은 없다.
`*.example`은 비밀값 없는 템플릿이며 placeholder로 plan하지 않는다. 자격증명은 외부 AWS profile/SSO 체인만 사용한다.

## 지금 필요한 사람 준비

1. 도구 설치는 완료했다. Terraform `/Users/ljm/.local/share/terraform/1.14.9/terraform`,
   AWS CLI `/Users/ljm/.local/share/aws-cli/aws`를 사용한다. 각각 버전 실행 exit0이며 설치·무결성 근거는 §10에 있다.
   전역 설치·sudo·셸 초기화 파일 변경은 하지 않았다. 다른 머신에서는 이 경로가 존재하는지 먼저 확인한다.
2. 사람이 `aws login`으로 승인 프로파일 `logstack-t4` 로그인을 완료했다. STS 계정 `324037288068` 일치와
   Terraform AWS provider6.63.0의 실제 bootstrap plan 인증을 각각 확인했다. 이전 프로파일0 상태는 §10의 이력이다.
   키·토큰·비밀번호는 채팅·tfvars에 넣지 않는다. 만료되면 사람만 아래 명령으로 갱신한다.
   IAM 콘솔 사용자용 `aws login`과 Identity Center의 `aws sso login`을 혼동하지 않는다.
   `/Users/ljm/.local/share/aws-cli/aws login --profile logstack-t4 --region ap-northeast-2`.
   `SignInLocalDevelopmentAccess` 등 필요한 권한이 없으면 관리자가 준비하며 에이전트가 권한을 추가하지 않는다.
   [AWS 콘솔 자격증명 로그인](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)을 따른다.
   bootstrap/provider와 runtime S3 backend/provider 인증은 별도 `credential_process` 없이 각각 실제 검증에 성공했다.
   필요성이 생긴 경우에만 사람이 최소 연동을 검토하며 `export-credentials`를 단독 실행해 값을 출력하지 않는다.
   서울 a/c 일반 AZ·Interface3서비스와 S3 Gateway의 지원/정책, 해당 리전 VPC/VPN 조회도 완료했다.
   조회된 VPC172.31.0.0/16·VPN[]만으로 로컬/온프레미스/다른 리전·전체 피어링의 충돌 부재를 보장하지 않는다.
3. 사람이 신규 상태 버킷 `logstack-bucket`을 생성했다. 사후 소유계정/서울·공개 차단·버전관리·AES256·소유권·TLS 정책을 확인했다.
   bootstrap은 기존 local state를 그대로 유지한다. runtime에 버킷을 중복 관리하거나 bootstrap state를 import/migrate하지 않는다.
   기존 backend의 잠금/설정이 코드와 다르면 자동 이전·잠금 전환 없이 결정 대기한다.
   이 코드는 승인된 신규 S3 `use_lockfile=true` 방식이다. backend 계정도 provider와 같은 승인 계정으로 제한한다.
   `allowed_account_ids`는 backend 예시의 운영 필수 입력이며 backend.tf가 누락을 기술적으로 차단하지는 않는다.
   runtime init 전 채운 backend.hcl의 비어 있지 않은 allowed_account_ids와 provider aws_account_id 및 STS 계정을
   사람이 대조한 기록을 남기는 것이 필수 gate다. 이 확인 전 실제 backend init/plan을 실행하지 않는다.
   계정과 backend에 연결하지 않는 `init -backend=false -input=false` 및 validate는 이 gate와 구분한다.
   별도 계정 backend는 별도 승인 전 사용하지 않는다. default workspace만 사용한다.
4. S3 관리 버킷/경로는 T4 현재 미입력이고 로그 그룹/보존은 후속 단계다. 빈 계약으로 네트워크 코드는
   plan 가능하지만 패키지 공급·로그 수집이 준비됐다는 뜻은 아니다. 후속 배포 전에 반드시 아래 계약을 채운다.

## 로컬 검증과 실제 plan 순서

저장소 루트에서 수행하는 재현 명령이다. 이번 실행의 개별 종료 코드·최초 오류·재시도는 §10과 ignored 로그를 확인한다.
init은 provider 다운로드가 필요할 수 있다. 네트워크가 막히면 정식 도구 승인으로 재시도하며 정책·서명 검증은 우회하지 않는다.

```sh
task_tf=/Users/ljm/.local/share/terraform/1.14.9/terraform
task_aws=/Users/ljm/.local/share/aws-cli/aws
"$task_tf" version
"$task_aws" --version
"$task_tf" fmt -recursive infra
"$task_tf" fmt -check -recursive infra
"$task_tf" -chdir=infra/bootstrap init -backend=false -input=false
"$task_tf" -chdir=infra/bootstrap validate
"$task_tf" -chdir=infra/runtime init -backend=false -input=false
"$task_tf" -chdir=infra/runtime validate
```

`init -backend=false + validate`는 계정/리전/backend에 대한 실제 plan 검증이 아니다.
기존 backend가 준비됐다면 bootstrap을 실행하지 않고 runtime으로 간다.
현재 승인된 비밀값 없는 `bootstrap/terraform.tfvars`는 ignored/0600으로 준비했다. 자격증명은 포함하지 않는다.
아래는 일반 재현 명령이며 이번에 저장·검토한 실제 plan의 정확한 경로와 SHA256은 §11을 따른다.

```sh
"$task_tf" -chdir=infra/bootstrap init -input=false
"$task_tf" -chdir=infra/bootstrap plan -input=false -detailed-exitcode -out=bootstrap.tfplan
```

plan의 0/2는 성공, 1은 오류다. plan의 생성·변경·삭제·교체 수 및 대상 주소를 별도 검토한다.
독립 리뷰 이후 **사람만** `terraform -chdir=infra/bootstrap apply bootstrap.tfplan`을 실행한다.
이 최초 apply는 **사람이 이미 수행했다**. 위 명령은 최초 준비 재현 설명이며 현재 버킷을 새로 만들기 위해 반복하지 않는다.
`bootstrap/terraform.tfstate`는0600으로 존재한다. 별도 안전 백업 완료는 미확인이므로 사람이 보존·복구 가능성을 확인한다.
Git ignore는 보존 수단이 아니다. 로컬 상태 분실 시 재생성하지 말고 사람에게 인계한다. 원격 상태 이전은 별도 승인이다.

기존 또는 사람 apply로 준비된 버킷 확인 후 `runtime/backend.hcl.example`과 `terraform.tfvars.example`을
각각 `backend.hcl`·`terraform.tfvars`로 복사하여 실제 승인된 비밀값 없는 식별자만 입력한다.

```sh
"$task_tf" -chdir=infra/runtime init -input=false -backend-config=backend.hcl
"$task_tf" -chdir=infra/runtime validate
"$task_tf" -chdir=infra/runtime plan -input=false -detailed-exitcode -out=runtime.tfplan
```

backend 변경/이전 질문이 나오면 중단한다. `-migrate-state`, `-reconfigure`, `-lock=false`, force-unlock을 자동 사용하지 않는다.
실제 plan은 코드와 함께 독립 검토하고 사람 apply 대기로 둔다. plan/state 전체는 출력·Git 커밋하지 않는다.
현재 bootstrap plan은 6생성/0변경/0삭제/0교체, runtime plan은 **60생성/0변경/0삭제/0교체**다.
현재 실제 runtime 저장 plan의 정확한 경로·SHA와 독립 리뷰·사람 적용 인계는 §12를 사용한다.
저장 plan apply는 추가 확인 질문 없이 실행될 수 있다. runtime VPC/NAT/Endpoint apply까지 승인된 것으로 보지 않는다.

## Backend 접근 권한

[HashiCorp S3 backend 계약](https://developer.hashicorp.com/terraform/language/backend/s3)에 따라 operator 권한을 별도로 확인한다.
인스턴스 역할에 backend 접근을 부여하지 않는다. bootstrap의 버킷 정책은 HTTPS 강제 Deny만 설정하며 operator Allow를 만들지 않는다.

| 권한 | 정확한 대상 |
|---|---|
| s3:ListBucket | 상태 버킷 ARN, 승인 state key prefix로 제한 |
| s3:GetObject / s3:PutObject | 승인된 runtime state key 객체 ARN |
| s3:GetObject / s3:PutObject / s3:DeleteObject | 같은 key의 `.tflock` 객체 ARN |

state 객체 DeleteObject는 필요하지 않다. 다른 workspace 경로·버킷 전체·후속 앱 역할로 권한을 넓히지 않는다.
기존 SSE-KMS backend라면 승인된 KMS 키의 별도 사용 권한도 검토한다. 신규 bootstrap은 SSE-S3이므로 새 KMS 키 비용이 없다.

## 서비스·관리 경로와 기능별 권한

| 경로 | SG/route | IAM·Endpoint 계약 |
|---|---|---|
| sender→int-alb TCP443 | 양방향 명시적 SG 참조 규칙 | T6 TLS/API 구현 대기 |
| int/ext-alb→receiver TCP3000 | SG 참조 | ALB 본체 없음, ext ingress 빈 상태 |
| receiver→db TCP5432 | SG 참조 | T5/T6 배포 대기 |
| sender/receiver/db→vpce TCP443 | 각 EC2 SG→vpce / 역방향 ingress | ssm/ssmmessages는 아래 채널만, 역할 ARN 제한 |
| sender/receiver→외부 TCP443 | 0.0.0.0/0 egress, app RT→public-A NAT | 도메인 제한 아님; HTTP80 없음 |
| 승인 역할→S3 TCP443 | 입력 역할만 S3 prefix-list egress, app/data RT→Gateway | `s3_read_paths`의 정확한 버킷/접두사 GetObject만 |
| CloudWatch Logs | logs Interface Endpoint 2AZ·Private DNS | 기본 Deny all, 그룹·보존·최소 권한 후속 확정 필요 |
| DB→인터넷 | 기본 경로/광범위 egress 없음 | AMI 또는 별도 승인 오프라인 공급, T5 전 해결 |

SSM 역할은 `ssm:UpdateInstanceInformation`과 `ssmmessages`의 Create/Open Control/Data Channel만 허용한다.
채널 API는 Resource `*`가 필요하므로 Endpoint에서 역할 ARN을 제한한다. 이 기반은 modern SSM Agent Session Manager용이며
[AmazonSSMManagedInstanceCore](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMManagedInstanceCore.html) 전체 기능을 제공하지 않는다.
GetParameter(s), KMS decrypt, inventory, association, patching, Agent 자동 업데이트 권한은 기본에서 제외한다.
T5~T7 전에 실제 AMI Agent 버전과 세션 동작을 검증하고 필요한 기능만 승인받아 추가한다.
운영자의 StartSession/포트포워딩 권한·대상 제한은 별도 operator 정책이다. 현재 인스턴스/세션 실측은 없다.

현재 계정의 Session Manager preferences·세션 KMS 요구는 미확인이다. Standard_Stream 세션이 S3/CloudWatch 로깅이나
KMS를 요구하면 현재 Deny/권한 부재가 세션을 차단할 수 있으므로 첫 관리 연결 전에 확인·해결한다.
이를 해결하려고 기존 감사/암호화 설정을 끄거나 광범위 권한을 선제 추가하지 않는다.
SSH·포트포워딩에는 Session Manager 세션 로깅이 지원되지 않으므로 로그 Deny가 모든 포트포워딩을 막는다고 단정하지 않는다.
[AWS 세션 로깅 범위](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-logging.html).
기본 5개 관리 action은 [AWS 최소 인스턴스 정책 예시](https://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-create-iam-instance-profile.html)에
대응하지만, Agent·operator·preferences·연결 실측까지 완료됐다는 뜻은 아니다.

S3 입력은 역할별 승인된 Agent/패키지 공급 read-only 경로다. `prefix`는 비어 있지 않고 `/`로 끝나며 wildcard를 포함할 수 없다.
코드는 그 아래 객체에만 `s3:GetObject`를 허용하고, 같은 범위로 IAM/Endpoint/SG를 생성한다. ListBucket·쓰기·백업 권한은 없다.
빈 `{}`이면 S3 Endpoint는 명시적 Deny all이며 DB의 S3 egress도 없다. 승인되지 않은 버킷을 임의로 선별하지 않았다.
AWS 관리 버킷은 [SSM VPC 문서](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html)의 기능/Agent 버전에 맞춰
정확한 지역별 버킷/경로를 승인한다. 필요한 cross-account bucket policy·서명 다운로드 지원을 별도로 확인한다.
S3 endpoint policy는 IAM을 대체하지 않는다. 후속 비밀값 권한도 역할별 정확한 ARN으로 분리한다.

## Output·태그·수명주기

runtime outputs는 VPC/CIDR, subnet ID/AZ/CIDR, RT, gateway/EIP allocation ID, SG6, Endpoint/S3 prefix-list,
역할 ARN/instance profile이다. 비밀값은 없다. 후속 단계는 이 runtime 루트를 확장하며 같은 네트워크를 새 루트로 복제하지 않는다.
provider default_tags로 Project=logstack-demo, Environment=demo를 적용한다. Name은 개별 자원에 적용한다.
태그 비지원 예외: 개별 route/RT association, IAM inline policy, S3의 policy/versioning/encryption/public-access/ownership 보조 설정.
S3 보조 설정은 태그된 버킷에 속한다. 기본 main RT/NACL은 AWS 생성 객체로 새 관리 자원으로 인수하지 않았다.
삭제·데이터 인수·상태 보존·잔존 비용은 [TEARDOWN.md](TEARDOWN.md)를 따른다.
기존 48/72시간 비용표의 NAT1/EIP1/Endpoint3×2AZ 수량은 동일하므로 유지한다. IAM/default SG 관리는 시간 고정비를 추가하지 않는다.
