# T4 승인·진행·재개 기록

기준일: 2026-09-09 KST. 이 문서는 AWS 실측 보고나 T4 완료 보고가 아니다.

**최신 상태는 §9 재개 기록을 우선한다. §1~8은 이전 사전검토의 이력으로 보존한다.
이전의 역할 복구 전 구현 금지·코드 없음·재개 프롬프트는 이번 사용자 요청 및 §9로 대체됐다.**

## 1. 현재 중단점과 승인 근거

- 사용자 승인: 「T4 사전검토 후속 — 역할 복구·규칙 추가·문서 정정·네트워크 구현」.
  원본 첨부: `/Users/ljm/.codex/attachments/51944b59-d0d1-4931-90db-a8303e97290b/pasted-text.txt`.
  다른 환경에서는 첨부 경로가 없을 수 있으므로 본문의 승인 표와 해당 사용자 메시지를 함께 확인한다.
- 작업 루트 `/Users/ljm/Desktop/logStack`, 브랜치 `main`, HEAD `f18e9c9653f464c7469bca6340b2641d63a28582`.
  origin/main보다 4커밋 앞섬. git add/commit/push·브랜치 조작 없음.
- 시작 시 staged/untracked 없음. 유일한 unstaged는 `.codex/agents/infra-reviewer.toml` 끝의 잘못된 백틱 제거였다.
  **이 변경은 이미 존재하던 변경이며 메인이 새로 고친 것이 아니다.** 정상 지침·이름·권한과 해당 변경을 보존했다.
- 7개 TOML 구문 검사 PASS. 실제 `infra-reviewer` 재호출은 `unknown agent_type 'infra-reviewer'`로 FAIL.
  메인이나 다른 이름의 reviewer로 대체해 독립 인프라 검토 완료를 주장하지 않는다.
- 사용자 §2 중단 조건에 따라 **문서·지침까지만 진행했다. infra-developer 위임과 .tf 작성은 BLOCKED**.
  bootstrap/runtime 디렉토리·provider lockfile·plan은 아직 없다. Terraform 코드 작성 완료가 아니다.
- 메인이 infra/AGENTS.md를 최초 생성하고 직접 읽었다. 이후 위임 대상도 직접 읽어야 한다.
- AI_RULES·src·sender·scripts·test·package·API·T3 보고/실행 증거는 변경 대상에서 제외했다.
  T3 30분 기록/DB 각27,205건·유실0, sender87/server12/e2e50은 기존 인수 결과다. 소크·sender 회귀는 재실행하지 않았다.

## 2. 확정 요구 / 채택 보완안 / 권고 / 미확인

| 분류 | 내용 |
|---|---|
| 확정 | 서울, VPC 10.0.0.0/16, public/app/data 각2, plan-aws §1의 6개 승인 CIDR |
| 확정 | Public NAT1+EIP를 public-A, app-A/B는 같은 NAT, data는 IGW/NAT 기본 경로 없음 |
| 확정 | 서비스 SG5+vpce SG1, Interface Endpoint ssm/ssmmessages/logs×2 AZ, S3 Gateway는 앱·데이터 RT |
| 확정 | 앱 외부 TCP443 egress 0.0.0.0/0 승인. 도메인 제한 아님. 공개 ingress/HTTP80/전체 egress 승인 아님 |
| 확정 | DB는 Endpoint·승인 S3 HTTPS만. 신뢰 가능한 사전 준비 AMI 우선, user_data 초기 설정 유지 |
| 확정 | 기존 서비스 범위 유지. RDS·새 브로커·CloudFront·NAT 다중화·이미지 빌더 추가 없음 |
| 확정 | 48~72시간 시연 후 사람이 runtime 삭제. 상태·기존 DNS 자산·공유 자원은 제외 |
| 채택 기본값 | Project=logstack-demo, Environment=demo. 현재 문서 검색에서 다른 확정 태그 미발견 |
| 채택/조건부 | backend 확인 시 안전 재사용. 없으면 bootstrap/runtime 분리, 신규 S3 use_lockfile=true, 신규 DynamoDB 없음 |
| 후보/실제 확인 필요 | AZ ap-northeast-2a/ap-northeast-2c. 계정의 일반 AZ/서비스 지원과 네트워크·VPN 중복 미확인. 불가 시 임의 대체 금지 |
| 권고 비용 시나리오 | receiver1+DB1 t3.medium, sender10 nano~micro 유지. 기존 small×2/nano×10과 구분하며 타입은 T5/T7 전 확정 |
| 미확인/T5 | PG16·SSM Agent·chrony 준비 AMI의 실제 존재·ID·신뢰·공급 비용·재현. 없으면 S3 대안 별도 승인 |
| 미입력/T4 | 계정 ID·프로파일/로그인 방식·backend 존재/설정/권한. 가짜 계정/버킷으로 실제 plan 금지 |
| 미입력/T6/T9 | 도메인·public Zone ID·dashboard FQDN·외부 CIDR. CIDR 전까지 ext-alb SG ingress 비움 |

### 설계·구현 인계

- 정확한 SG 서비스/관리 표·CIDR/RT는 plan-aws.md §1, 보안·수명주기는 docs/design-aws.md §3·7·9·11을 따른다.
- Interface Endpoint는 앱 2 AZ의 ENI와 private DNS, VPC DNS support/hostnames를 명시한다.
  S3 Gateway는 app-A/B·data-A/B RT에 연결하고 S3 prefix-list egress를 사용한다.
- Endpoint 정책과 IAM은 기능별 Action/Resource 및 실제 승인 버킷에 맞춰 제한한다.
  T4에서 광범위 AmazonSSMManagedInstanceCore의 GetParameter를 관성적으로 붙이지 않는다.
  관리 채널과 후속 비밀값 조회 권한을 분리한다. 좁은 Allow를 추가해도 기존 넓은 Allow는 제한되지 않는다.
- AWS SSM 관리 버킷은 필요한 Agent 기능/버전 기준으로 선별한다. 프로젝트 패키지·백업 버킷명은 미확인이다.
  부족한 버킷 입력을 wildcard나 임의 신규 버킷 생성으로 대체하지 말고 계약을 남긴다.
- provider와 backend의 allowed_account_ids에 검증된 계정을 제한하는 방안을 적용한다.
  backend 계정이 다르면 별도 명시 승인·권한 확인이 필요하다. 계정 조회 skip으로 우회하지 않는다.
- bootstrap: 처음에는 로컬 상태, 별도 사람 apply, 버전관리/암호화/공개차단/HTTPS강제/삭제보호/force_destroy=false.
  보존한 로컬 상태의 명시적 이전과 runtime backend 초기화를 구분한다. 기존 잠금/상태를 자동 변경하지 않는다.
- 예정 파일: bootstrap의 versions/providers/main/variables/outputs.tf;
  runtime의 versions/providers/backend/variables/network/security-groups/endpoints/iam/outputs.tf.
  과도한 모듈·새 저장소 의존성 없음. SG와 개별 규칙을 분리하고 지원 리소스에 태그를 적용한다.
- 예정 infra/.gitignore: 실제 tfvars·backend 로컬 설정·plan·state·.terraform 제외;
  .terraform.lock.hcl과 비밀값 없는 예시는 관리. 아직 코드가 없어 이 파일/예시/lockfile도 생성하지 않았다.
- 후속 output 계약: VPC ID/CIDR, AZ별 public/app/data subnet ID, RT ID, NAT/IGW,
  SG6 ID, Endpoint ID/S3 prefix list, IAM role ARN/instance profile. 비밀값 output 없음.

## 3. 실제 환경·역할 확인 결과

- Mac arm64. `aws`, `terraform`, `session-manager-plugin`은 PATH에서 발견되지 않았다.
  /usr/local/bin·/opt/homebrew/bin의 AWS/Terraform 및 확인한 대표 설치 위치에도 없었다.
  Homebrew만 /opt/homebrew/bin/brew에 존재. 이를 도구 설치 완료로 해석하지 않는다.
- 기본 ~/.aws/config·credentials 없음. AWS_PROFILE/AWS_REGION/AWS_DEFAULT_REGION unset.
  다른 인증 경로까지 없다는 단정은 아니다. 자격증명 실제값은 읽거나 출력하지 않았다.
- 프로젝트 trust_level=trusted. .codex/config.toml은 agents enabled=true, 동시 한도2,
  approval_policy=on-request, sandbox_mode=workspace-write. 현재 실행 승인 방식 auto_review와 차이가 있으나 변경하지 않았다.
- `/Applications/ChatGPT.app/Contents/Resources/codex --version`: exit0, codex-cli 0.153.4.
  경고 원문: `WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)`.
- 프로젝트 config와 standalone 역할 파일 6개의 TOML 파싱은 기존 pip._vendor.tomli로 PASS(exit0).
  새 Python/npm 의존성 설치 없음. actual role retry는 오류 `unknown agent_type 'infra-reviewer'`.
  공식 standalone 형식과 일치하지만 현재 세션의 로딩 갱신 시점·오류 원인은 확정할 수 없다.
  [공식 역할 문서](https://learn.chatgpt.com/docs/agent-configuration/subagents).
- 필요한 조치: 사람의 앱 재시작 또는 새 작업에서 수정된 정의를 읽는 세션을 시작하고 실제 역할 호출 재확인.
  재시작하면 해결된다고 보장하지 않는다. 계속 실패하면 코드 위임 없이 원문 오류·버전·설정을 재확인한다.

## 4. 실제 검증 기록

실행일 2026-09-09 KST(UTC 2026-09-08), 명령 원문 출력은 현재 Codex 작업 도구 기록에 있다.
아래는 비밀값 없는 요약이다. 재실행하지 않은 항목에 종료 코드 0을 넣지 않는다.

| 검사/명령 | 상태 | 종료 코드·증거 |
|---|---|---|
| pwd/branch/HEAD/status·git diff -- role 파일 | PASS | 0; 위 §1 기준, 시작 시 역할 파일만 수정 상태 |
| 기존 pip._vendor.tomli로 config+agents 7파일 load | PASS | 0; 전부 PASS 출력, 구문과 runtime 호출은 별개 |
| infra-reviewer 실제 spawn 재시도 | FAIL | 도구 오류(프로세스 exit 없음): unknown agent_type 'infra-reviewer' |
| codex --version | PASS(경고 포함) | 0; 0.153.4, PATH alias 경고 위 원문 |
| Mac/PATH/프로파일 존재·프로젝트 trust 조회 | PASS | 0; 도구/입력 부재를 확인했을 뿐 인증 PASS 아님 |
| npm run lint | PASS | 0; eslint 자동 수정 옵션 없음. 도구 session82182 |
| npm run build | PASS | 0; Nest build, 실행 중 서비스 재시작 없음. session13776 |
| npm test -- --runInBand | PASS | 0; 3 suites/12 tests, 1.906s. session70295 |
| npm run test:e2e | BLOCKED / NOT_RUN | 없음; ingestion:125~126, metrics:56~57의 deleteMany가 기존 DB를 변경함. 격리 대상 미지정 |
| sender 회귀·통합·30분 소크 | NOT_RUN | 없음; 기존 T3 증거 인수, 불필요한 재실행 없음 |
| bootstrap/runtime fmt/init/validate | BLOCKED / NOT_RUN | 없음; 역할 미복구로 코드 없음, Terraform 없음 |
| bootstrap/runtime 실제 plan/show | BLOCKED / NOT_RUN | 없음; 코드·도구·검증된 계정/backend 미준비 |
| 독립 infra 설계/코드/plan 리뷰 | BLOCKED / NOT_RUN | 역할 호출 실패. plan 생성/변경/삭제/교체 수는 미산출(0 아님) |
| apply/destroy/import/state/force-unlock/terraform test | NOT_RUN | 없음; 권한 범위 밖, 우회 실행 없음 |
| AWS STS/AZ/서비스/네트워크/backend 조회 | BLOCKED / NOT_RUN | 없음; 도구/로그인·대상 미준비. 접근 거절을 리소스 없음으로 해석하지 않음 |
| 공개 AWS 서울 가격표 조회 | PASS(재시도) | 최초 DNS 실패, 승인된 외부 읽기 재시도 exit0. 자격증명 없는 공개 CSV만 조회 |
| 원범위 git diff --exit-code 및 T3 §4 바이트 대조 | PASS | 0; 불변식/앱/T3/설정/스킬/루트 ignore 무변경, design-aws §4 동일 |
| 비용 산식 독립 산술 확인 | PASS | 0; Node 계산으로 두 기간의 소계/3시나리오 일치 확인 |
| docker compose ps --format json | PASS(재시도) | 최초 socket 권한 오류 exit1, 읽기 전용 승인 재시도 exit0. app running/DB healthy, app Mounts 없음 |
| git diff --check | PASS | 0; 최종 검사 결과는 아래 갱신 기록과 현재 작업 출력 참조 |

진단 부가 기록: 최초 ps는 exit127 `zsh:1: operation not permitted: ps`, 읽기 전용 승인 재시도 exit0.
기존 Claude PID56374와 Node56389/56390을 확인했으며 신호·중단 명령은 보내지 않았다.
일부 탐색에서 없는 sender/package.json(exit1), sender/src/index.ts·sender/README.md·대체 compose 파일(exit2)을 확인했다.
실제 root package.json, sender/src/main.ts·config.ts·daemon.ts, docker-compose.yml로 해소했다. 앱은 이미지의 dist를 사용한다.
공개 가격표 첫 조회 오류: `<urlopen error [Errno 8] nodename nor servname provided, or not known>`.
래퍼가 오류를 JSON으로 보고해 exit0이었으므로 첫 조회 자체를 성공으로 기록하지 않는다.
AWS CLI changelog의 웹 click은 invalid arguments였고 공식 raw changelog 직접 조회로 해소했다.

## 5. 서울 48/72시간 비용 — 공식 단가 기반 계획, 실측/상한 아님

확인일 2026-09-09 KST. USD, 서울(ap-northeast-2), Linux shared On-Demand, 예약/Spot·할인·크레딧 적용 전.
세금·환율·유료 AMI·초과 CPU credit·실제 데이터량/스토리지/로그는 고정비 합계에서 제외한다.
비용 때문에 승인 Endpoint·보안·백업을 제거하지 않는다. 48/72시간 외 준비·대기·삭제 지연 시간도 과금될 수 있다.

### 가격 출처·선별 근거

공식 [가격표 조회 방식](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html)에 따라
아래 공개 CSV를 메모리에서 읽어 서울 OnDemand 행만 선별했다. 배포 계정 조회가 아니다.

| 출처 | 단가·SKU |
|---|---|
| [EC2 서울 버전20260908132326](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/20260908132326/ap-northeast-2/index.csv), 적용일2026-09-01 | nano $0.0065/h(H7ZUWUQM6CR4EC83), micro $0.013/h(NYVHMS44MY8N2F3M), small $0.026/h(PZHVQ3KFPA3RHA5V), medium $0.052/h(G5CAZXC4M5ENHEZN) |
| 같은 EC2 표 | Zonal NAT $0.059/h(P63FHTYZXQBC6HX5), 처리 $0.059/GB(HC3MBQKUG7PB4BYX), gp3 $0.0912/GB-month(MTK7D9SGKGYR3JD6). Regional NAT/NLB 행은 미사용 |
| [VPC 서울 버전20260831092232](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/20260831092232/ap-northeast-2/index.csv), 적용일2026-07-01 | Interface Endpoint $0.013/AZ-hour(BH2CREBM4CXH3HB5), 첫1PB 처리 $0.01/GB(K4QBYWVDC6VAS9E8), 공인IPv4 $0.005/IP-hour(ZKBHEVDXYBRCKFQ8). Resource/GWLBE/contiguous block 행은 미사용 |
| [ELB 서울 버전20260831092255](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/20260831092255/ap-northeast-2/index.csv), 적용일2026-08-01 | ALB $0.0225/h(VUV9M7PZ543S2SC9), LCU $0.008/LCU-hour(CX4ZBV2SE6F5HJV3). NLB/Outposts/Trust Store/예약 LCU 제외 |
| [S3 서울 가격표](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-northeast-2/index.csv), 선택 행 적용일2026-08-01 | Standard 첫50TB $0.025/GB-month(3JSN7K7UDDNCYCDM), PUT/COPY/POST/LIST $0.0045/1000(D3S5DN86CFPGUM5G), GET 등 $0.00035/1000(84G6KSFBGCU9CEC9) |

Endpoint 과금은 서비스 수×AZ 수다. 3개 서비스 객체가 각각 2개 AZ에 있으므로 총6 Endpoint-AZ이며
S3 Gateway를 유료 Interface Endpoint 1개로 더하지 않는다. [공식 PrivateLink 과금](https://aws.amazon.com/privatelink/pricing/).

### 표 A — T4

| 항목 | 수량·단가·가정 | 48시간 | 72시간 |
|---|---|---:|---:|
| Public NAT | 1×$0.059/h | $2.832 | $4.248 |
| NAT EIP | 1×$0.005/h | $0.240 | $0.360 |
| Interface Endpoint | 3서비스×2AZ×$0.013/h | $3.744 | $5.616 |
| 위 시간 고정비 소계 | $0.142/h | **$6.816** | **$10.224** |
| NAT 처리 | 각 구간 실제 GB=N48/N72, $0.059/GB | 0.059×N48 | 0.059×N72 |
| Endpoint 처리 | 각 구간 실제 GB=E48/E72, 첫1PB 단가 | 0.01×E48 | 0.01×E72 |
| 상태 S3 저장 | 버전 포함 평균 G GB, 계산 편의 월730h | 0.001644×G | 0.002466×G |
| S3 요청·잠금 | 각 구간 PUT/LIST 등 P건, GET 등 R건 | 0.0000045×P48 + 0.00000035×R48 | 0.0000045×P72 + 0.00000035×R72 |
| 교차 AZ/인터넷 전송·선택 KMS | 실제 경로/GB/키 미확인 | 미산정 | 미산정 |

N/E/G/P/R은 미측정이며 0이라고 가정하지 않았다. S3 월730시간 환산은 계획 편의값이지 실제 청구월 보장값이 아니다.
상태 버킷은 데모 후에도 남으므로 위 48/72시간 이후 저장·요청 비용도 계속된다. 소계는 전체 견적이 아니다.

### 표 B — T5~T9까지 완성 시 비교

외부 ALB 공인 IPv4는 비용 계산용 2개(2AZ) 가정이다. 실제 확장 시 주소 수를 다시 확인한다.
내부 ALB에는 공인 IPv4 비용을 넣지 않는다. ALB 기본료와 LCU는 별도다.

| 항목/시나리오 | 수량·단가 | 48시간 | 72시간 |
|---|---|---:|---:|
| T4 시간 고정비 | 위 표 | $6.816 | $10.224 |
| 내부+외부 ALB 기본료 | 2×$0.0225/h | $2.160 | $3.240 |
| 외부 ALB IPv4 가정 | 2×$0.005/h | $0.480 | $0.720 |
| 기존 EC2안 | nano10+small2 = $0.117/h | $5.616 | $8.424 |
| 권고 EC2안 A | nano10+medium2 = $0.169/h | $8.112 | $12.168 |
| 권고 EC2안 B | micro10+medium2 = $0.234/h | $11.232 | $16.848 |
| 기존안 시간 고정비 합계 | T4+ALB+IPv4+기존EC2 | **$15.072** | **$22.608** |
| 권고 A 시간 고정비 합계 | T4+ALB+IPv4+권고A | **$17.568** | **$26.352** |
| 권고 B 시간 고정비 합계 | T4+ALB+IPv4+권고B | **$20.688** | **$31.032** |
| ALB LCU | 내부/외부 모두 합한 LCU-hours×$0.008 | 사용량 미확인 | 사용량 미확인 |
| gp3 기본 용량 | 전체 평균 V GB×$0.0912/GB-month, 월730h 가정 | 0.005997×V | 0.008995×V |
| gp3 추가 IOPS/처리량 | 설정·단가 미확인 | 미산정 | 미산정 |
| snapshot·AMI backing snapshot·유료 AMI | 용량·보존기간·공급원/단가 미확인 | 미산정 | 미산정 |
| pg_dump S3 저장·요청 | 위 S3 단가, 용량/버전/보존 미확인 | 미산정 | 미산정 |
| CloudWatch 수집/저장/조회 | 로그량·보존·단가 미확인 | 미산정 | 미산정 |
| DNS·기존 Zone·도메인 갱신 | 기존 공유 비용/쿼리량·단가 미확인 | 별도 잔존비용 | 별도 잔존비용 |
| 데이터 처리/전송·CPU 초과 credit | 실제 사용량·적용 조건 미확인 | 별도 추가 | 별도 추가 |

EC2안 3개는 선택지이므로 서로 합산하지 않는다. medium은 receiver/DB 2대만의 비용 시나리오이며 타입 확정이 아니다.
T3 Standard는 credit 고갈 시 baseline 성능으로 제한되고, Unlimited는 초과 credit 과금이 가능하다.
기본값에 맡기지 않고 T5/T7 전에 역할별 모드·성능·추가 과금 한도를 확인한다.
[Standard](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-standard-mode.html),
[Unlimited](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode.html).

### 이벤트 생성 구간은 별도

150건/초 연속 생성의 계산: 48h=25,920,000건, 72h=38,880,000건. **설계 가정 산술이지 AWS 실측이 아니다.**
T7/T8에 생성 시간·원본/인덱스/파생/실패저널 용량·EBS 여유·로그량·지표 성능을 별도로 확인한다.
sender/src/config.ts와 daemon.ts 읽기 결과 USERS=0 또는 EVENT_RATE=0에서 신규 생성 없이 drain 가능하다.
설정은 프로세스 시작 시 읽으며 자동 시간 제한 옵션은 없다. SIGTERM은 전체 drain이 아니라 진행 중 응답 처리 후 종료한다.
같은 UUID·키·OUTBOX_DIR의 단일 writer 재시작 절차로 생성 구간을 운영에서 제어한다. T4에서 sender 코드를 바꾸지 않는다.
운영 main.ts에는 테스트의 onRecorded 기반 독립 recorded-ID 수집기가 연결되어 있지 않다.
T7/T8에서 생성 시작 전에 독립 기록 성공 집합 G의 수집·보존 방법을 별도 설계·승인한다.
종료 후 compact된 outbox나 검증 대상 DB로 G를 재구성하지 않는다. 기존 통합 테스트 관측기를 운영 구현 완료로 간주하지 않는다.

## 6. 사람에게 필요한 입력 (비밀값 제외)

| 입력 | 필요한 시점 |
|---|---|
| 사용할 AWS 프로파일/로그인 방식, 배포 계정 ID | 실제 환경 읽기/plan 전. access key/secret/token은 채팅으로 받지 않음 |
| 기존 상태 버킷 이름·리전·key·잠금 방식, 없으면 신규 bootstrap 선택 확인 | backend 준비 전. 권한 오류는 부재로 취급하지 않음 |
| 보유 도메인·public Hosted Zone ID·최종 dashboard FQDN | T6/T9 인계, T4 코드 작성 차단 아님 |
| 외부 접속 허용 CIDR | T9 접근 검증 전. T4 빈 목록 유지 가능 |

## 7. 설치·인증·구현 재개 순서

아래는 **사람 준비/다음 작업용, 이번에 실행하지 않은 명령**이다. 전역 설치/업그레이드·쉘 설정·자격증명 파일 수정은 별도 승인이다.

1. 사람이 앱 재시작 또는 새 작업을 열고 §8 프롬프트로 infra-reviewer 실제 호출을 재확인한다.
   역할 복구 전에는 .tf를 작성하지 않는다. 복구 후 수정 설계·승인 표를 독립 검토하여 새로운 High/직접 미결을 해소한다.
2. 단일 infra-developer에게 T4 infra/만 위임한다. 루트·infra/AGENTS.md와 infra-audit를 직접 읽게 하고 재위임을 금지한다.
   도구/인증이 없어도 역할이 복구됐으면 필수 변수·비밀값 없는 예시 기반 코드는 작성할 수 있다.
3. arm64용 설치 후보: Terraform **1.14.9**(공식 배포 파일 확인, 이 환경 실행 검증 전), AWS CLI v2 **2.36.40**
   (조회한 공식 changelog 최상단, 설치/실행 전). 지원 버전 최종 선택·provider 제약/lockfile은 설치 검증 후 기록한다.
   [Terraform 배포](https://releases.hashicorp.com/terraform/1.14.9/),
   [AWS 설치](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html),
   [AWS changelog](https://raw.githubusercontent.com/aws/aws-cli/v2/CHANGELOG.rst).

   사람이 별도로 승인·실행할 설치 예시(전역 설치는 마지막 installer 단계):

   ```sh
   install_dir=$(mktemp -d /private/tmp/logstack-tools.XXXXXX)
   curl --fail --location https://awscli.amazonaws.com/AWSCLIV2-2.36.40.pkg -o "$install_dir/AWSCLIV2.pkg"
   pkgutil --check-signature "$install_dir/AWSCLIV2.pkg"
   # AWS 공식 서명을 확인한 후에만 사람이 실행:
   sudo installer -pkg "$install_dir/AWSCLIV2.pkg" -target /
   aws --version
   curl --fail --location https://releases.hashicorp.com/terraform/1.14.9/terraform_1.14.9_darwin_arm64.zip -o "$install_dir/terraform.zip"
   curl --fail --location https://releases.hashicorp.com/terraform/1.14.9/terraform_1.14.9_SHA256SUMS -o "$install_dir/SHA256SUMS"
   shasum -a 256 "$install_dir/terraform.zip"
   rg 'terraform_1.14.9_darwin_arm64.zip' "$install_dir/SHA256SUMS"
   # 공식 서명/체크섬 일치를 확인한 뒤 추출. PATH·전역 설치 변경은 별도 승인:
   unzip "$install_dir/terraform.zip" -d "$install_dir/terraform-bin"
   "$install_dir/terraform-bin/terraform" version
   ```

4. 사람이 기존 SSO/로컬 프로파일로 로그인한다. 실제 프로파일을 받은 후 `aws sso login --profile <확정 프로파일>`이 필요한지 판단한다.
   STS 계정 대조, a/c 일반 AZ·Endpoint 서비스/지원 AZ, 기존 VPC/subnet/VPN·CIDR, backend 접근/잠금을 읽기 전용 확인한다.
   공급한 프로파일을 모든 조회에 지정하고 provider/backend 계정 제한과 일치시킨다.
   EC2 타입 가용성·vCPU quota는 T5~T7 후속 확인, quota 증액 자동 요청 없음. Session Manager plugin은 T6 준비 목록이다.
5. 코드·도구 준비 뒤 각 root에서 `terraform -chdir=infra/bootstrap fmt -check` 및 runtime 동등 명령.
   최초 bootstrap은 로컬 backend, runtime 정적 검사는 `terraform -chdir=infra/runtime init -backend=false` 후 validate.
   `init -backend=false + validate`는 실제 backend plan 검증이 아니다. .gitignore 준비 뒤만 실제 로컬 설정/plan을 저장한다.
6. 신규 backend라면 검증된 계정/변수로 bootstrap init/validate/plan -detailed-exitcode를 먼저 수행한다.
   plan을 독립 리뷰하고 사람이 최초 apply할 때까지 runtime backend init/plan은 대기한다.
   기존 backend면 설정·잠금·상태를 바꾸지 않고 검증된 backend 설정으로 runtime init/validate/plan한다.
   초기화 시 migration/reconfigure 요구가 나오면 자동 승인하지 말고 기존 상태와 별도 승인을 확인한다.
7. 실제 plan 명령형은 `terraform -chdir=infra/runtime plan -detailed-exitcode -out=runtime.tfplan`.
   준비된 실제 입력만 사용한다. 0/2 성공, 1 오류. 비밀 제거 생성/변경/삭제/교체 요약과 실제 plan을 reviewer가 독립 검토한다.
   CLI/SDK 우회 apply, import/state 변경, 자동 상태 이전/force-unlock/terraform test 금지.
8. infra-audit 결과와 문서·검증 증거를 갱신한다. 사람 apply·연결·부트스트랩·AWS 실측은 이후 별도 단계다.

## 8. 재개 프롬프트

> 현재 저장소의 루트 AGENTS.md 필수 순서와 infra/AGENTS.md, infra/T4_STATUS.md, infra/TEARDOWN.md를 읽고
> 2026-09-09 T4 후속 승인을 이어서 수행하라. T3/사전검토를 처음부터 반복하지 말고 현재 git 상태를 확인하라.
> infra-reviewer.toml의 백틱 제거는 시작 전 기존 변경이었고 TOML7개는 정상이나 이전 세션에서
> 실제 infra-reviewer 호출이 unknown agent_type으로 실패했다. 역할을 실제 호출해 성공 여부부터 확인하라.
> 실패하면 문서·지침까지만 유지하고 .tf 구현을 하지 마라. 성공하면 수정 설계와 승인표를 독립 검토한 뒤
> High/직접 미결이 없을 때 infra-developer 단일 작성자로 T4만 구현하라. 자식은 재위임하지 않는다.
> 계정/도구/backend 미확인은 코드와 실제 plan을 구분해 다뤄라. apply/destroy·시크릿 조회·Git 조작 금지.
> 기존 프로세스·DB·T3 증거를 보존하고 이 상태 기록의 검증/비용/대기 항목을 갱신하라.

### 이전 감사·최종 갱신 (사전검토 이력)

- infra-audit를 T4 범위에 적용했다. 역할 미복구·코드/실제 plan 부재로 독립 인프라 감사 완료는 아니다.
- T5 DB 공급/부트스트랩/백업 실측, T7 10대 실측, T9 HTTPS 화면 검증은 현재 NOT_APPLICABLE(후속 단계).
- docs-auditor 실제 재호출로 읽기 전용 문서 감사 수행. 신규 High/Med 없음,
  Low 1건(운영 독립 recorded-ID 증거 수집 방식의 T7/T8 인계)을 본문·TEARDOWN에 명시했다.
  반영 후 해당 문단의 독립 재검토 완료: 문서 인계 Low 해소, 최종 문서 감사 잔여 High0/Med0/Low0.
  운영 수집기 자체의 구현·AWS 실행 증거가 완성됐다는 의미는 아니다.
  이 감사는 infra-reviewer 설계/코드/실제 plan 독립 리뷰를 대체하지 않는다.
- 삭제/보존/잔존 비용 절차는 TEARDOWN.md에 있다. 실제 삭제·잔존 비용 0 확인은 하지 않았다.
- 최종 변경: 기존 사용자 수정 .codex/agents/infra-reviewer.toml 보존;
  메인 수정 AGENTS.md, plan-aws.md, docs/design-aws.md; 메인 신규 infra/AGENTS.md, T4_STATUS.md, TEARDOWN.md.
  루트 AGENTS의 파일 끝 개행 외에 일반 구현 권한 확장은 없다. staged 없음, 범위 밖 추적 파일 변경 없음.
  build의 ignored 산출물은 정상 검증 결과이며 T3 outbox/증거는 쓰거나 삭제하지 않았다.


## 9. T4 실제 구현 재개 (2026-09-09 KST)

사용자 원본 `/Users/ljm/.codex/attachments/d01c5eae-0c31-456a-af45-38a6cd521009/pasted-text.txt`:
로컬 코드 작성과 등록/도구 준비를 분리하고 독립 검토 대기여도 승인 코드 작성을 허용했다.
T4 preflight 스킬은 다시 활성화하지 않았다. bootstrap/runtime 기존 .tf가 없음을 확인하고 두 실행 루트만 작성했다.
기준 HEAD `f18e9c9653f464c7469bca6340b2641d63a28582`, main을 그대로 유지했다.
시작 Git은 staged 7파일(.codex/agents/infra-reviewer.toml, AGENTS.md, docs/design-aws.md,
infra/AGENTS.md, infra/T4_STATUS.md, infra/TEARDOWN.md, plan-aws.md)이다. 깨끗한 상태가 아니었다.
메인이 infra/AGENTS.md에 이번 예외만 기록했고 단일 infra-developer 자식이 infra 코드·예시·문서를 작성했다.
기존 staged/unstaged 변경은 보존하며 git add/commit/push나 브랜치 조작을 하지 않았다.

### 역할 진단 (이번 실행)

- 실제 현재 도구에 infra-developer/infra-reviewer가 노출되며 **두 역할 모두 spawn 성공**했다.
  일반 자식 대체 위임이나 설정 수정을 하지 않았다. 작성자의 재위임 없음.
- 프로젝트 설정/역할 TOML7개 parse PASS(exit0), 개인 agents/global 설정에서 동일 역할 중복 미발견.
  프로젝트 config_file 선언은 없다. TOML 성공과 실제 호출 성공을 각각 확인했다.
- [공식 standalone 역할](https://learn.chatgpt.com/docs/agent-configuration/subagents)의 name/description/developer_instructions 및
  [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)의 config_file 선언 위치 기준 상대경로를 확인했다.
- CLI 0.153.4(exit0)는 PATH alias EPERM 경고가 있으며 이 대화의 앱 runtime과 동일하다고 확인되지 않았다.
  auto_review는 승인 검토 주체이며 on-request와의 충돌로 판정하지 않았다. 권한 설정은 완화하지 않았다.
- reviewer에게 읽기 전용 지시를 전달했다. 실제 표시 sandbox는 workspace-write이므로 도구 수준 read-only 격리로 주장하지 않는다.

### 실제 작성 파일과 범위

- `infra/bootstrap/{versions,providers,variables,main,outputs}.tf` (5개)
- `infra/runtime/{versions,providers,backend,variables,network,security-groups,iam,endpoints,outputs}.tf` (9개)
- `infra/.gitignore`, `infra/README.md`, 양쪽 `terraform.tfvars.example`, `runtime/backend.hcl.example`
- 이 문서와 `infra/TEARDOWN.md` 최신 진행·재개 지점 갱신. 기존 비용표·T3 증거는 유지했다.

승인 네트워크/관리 IAM/Endpoint/S3 backend 기반의 코드 초안을 작성했다.
서비스 SG6 외 AWS가 자동 생성한 기본 SG의 permissive 규칙을 제거하는 관리 자원1개가 있다.
`_c` key는 승인 표 B 서브넷(AZ c 후보)에 대응한다. 실제 AZ/서비스/CIDR 충돌은 미확인이다.
비어 있는 S3 계약은 Endpoint Deny all + DB S3 egress 없음으로 유지한다. 승인 read path 입력 시 GetObject만 역할별로 열린다.
로그 그룹 미확정으로 Logs Endpoint도 Deny all이다. SSM은 modern Agent의 UpdateInstanceInformation/메시지 채널 기반만 제공한다.
Agent 공급·로그·패치·inventory·시크릿·백업이 준비됐다는 뜻이 아니다. 후속 배포 전 입력과 동작 검증을 별도로 수행한다.
backend allowed_account_ids는 **운영 필수 계약**이고 backend.tf가 누락 자체를 강제하지 않는다.
init 전 backend.hcl/입력 계정/STS의 일치와 default workspace를 사람이 확인한 기록을 남긴다.

### 이번 검증 및 미실행

| 검사 | 상태 | 명령·종료 코드·근거 |
|---|---|---|
| 필수 문서/승인표/전체 기존 infra 읽기 | PASS | cat/sed/rg exit0; 첨부와 현재 저장소 대조 |
| Terraform/AWS 존재 확인 | PASS(부재 관측) | 메인 PATH·/opt/homebrew/bin·/usr/local/bin 확인, 도구 미발견; 전체 머신 미설치 주장은 아님 |
| 인증 준비 | BLOCKED | 기본 ~/.aws/config·credentials 없음, 관련 profile/region/credential-path 환경 설정 unset; 실제 비밀값 조회 없음 |
| npm run lint | PASS | exit0, 이번 메인 session79342 |
| npm run build | PASS | exit0, 이번 메인 session80187 |
| npm test -- --runInBand | PASS | exit0, session5207, 3 suites/12 tests, 1.295s |
| npm run test:e2e | NOT_RUN | ingestion125-126/metrics56-57 deleteMany가 기존 DB 쓰기; 안전 대상 미지정 |
| T3 sender 회귀/통합/소크 | NOT_RUN | 이번 자동 재실행 없음, 기존 증거만 인수 |
| bootstrap/runtime fmt·fmt-check | BLOCKED / NOT_RUN | Terraform 미발견, 종료 코드 없음 |
| bootstrap/runtime init -backend=false + validate | BLOCKED / NOT_RUN | Terraform 미발견, 종료 코드 없음; lockfile 생성 없음 |
| bootstrap 실제 plan | BLOCKED / NOT_RUN | 도구·승인 계정·기존 backend 재사용 여부/신규 버킷 입력 대기 |
| runtime 실제 plan | BLOCKED / NOT_RUN | 도구·승인 계정·AZ/서비스·backend 입력/권한 대기 |
| Git ignore 계약 | PASS | 메인 Python subprocess git check-ignore --quiet 검사 exit0: 실제 state/plan/backend/tfvars/.terraform/log ignored, lockfile·3예시는 추적 가능; 임시 파일 생성 없음 |
| 정적 텍스트 자체 점검 | PASS | Python exit0: .tf 14개, 금지 EC2/ALB/시크릿/provisioner 문자열 및 data default-route block 부재; HCL 구문 검증 아님 |
| git diff --check / git diff --cached --check | PASS | exit0; 기존 staged 변경 보존 |
| 코드 독립 리뷰 | PASS(코드만) | 실제 infra-reviewer 최종 검토: bootstrap/runtime 코드 수준 수용, 잔여 High0/Med0/Low0. README backend 계정 운영 gate 보강 수용; 파일 수정 없음 |
| 실제 plan 독립 리뷰 | NOT_RUN | plan 없음, 코드만 리뷰 가능 |
| apply/destroy/import/state/force-unlock/terraform test | NOT_RUN | 에이전트 금지, 우회 실행 없음 |

bootstrap/runtime **실제 plan 생성·변경·삭제·교체 수는 각각 미산출**이며 0이 아니다.
기존 48/72시간 서울 비용표의 NAT1/EIP1/Interface3×2AZ 수량은 그대로다. 비용표 갱신 없음.
기존 고정비 소계는 총비용/상한이 아니며 상태 버킷 저장·요청·보존 비용과 사용량 변동비는 별도다.

### 사람 작업과 정확한 재개 지점

1. 도구 설치(별도 승인), profile/로그인 방식·승인 계정 ID, 기존 backend bucket/region/key/잠금·권한 확인.
2. 설치 후 첫 명령 `terraform version`, `terraform fmt -recursive infra`, `terraform fmt -check -recursive infra`.
3. `terraform -chdir=infra/bootstrap init -backend=false`, `terraform -chdir=infra/bootstrap validate`;
   `terraform -chdir=infra/runtime init -backend=false`, `terraform -chdir=infra/runtime validate`.
   실제 생성 lockfile과 선택 provider 버전을 검토한다. 자세한 설치·입력·검증 절차는 README를 따른다.
4. 신규 bootstrap이 필요하면 승인 tfvars를 채우고 `terraform -chdir=infra/bootstrap init`,
   `terraform -chdir=infra/bootstrap plan -input=false -detailed-exitcode -out=bootstrap.tfplan` → 독립 리뷰 → 사람만 apply.
   로컬 bootstrap 상태는 안전 보관하며 원격 이전을 자동 수행하지 않는다.
5. 기존/신규 backend 준비 후 계정 gate를 통과하고 `terraform -chdir=infra/runtime init -backend-config=backend.hcl`,
   `terraform -chdir=infra/runtime plan -input=false -detailed-exitcode -out=runtime.tfplan` → 실제 plan 독립 리뷰 → 사람 apply 대기.
6. S3 관리 버킷/경로·Agent 버전은 후속 배포 전 승인한다. AMI·로그·시크릿/백업·도메인/Zone/T9 CIDR은 해당 단계 인계다.

코드 작성은 진행됐지만 도구 검증·실제 plan과 그 독립 리뷰·사람 apply·AWS 실측이 남아 **T4 전체 완료가 아니다**.


작성 종료 시 Git: 기존 staged7 유지, infra/AGENTS.md·T4_STATUS.md·TEARDOWN.md는 추가 unstaged 변경(AM),
신규 untracked는 infra/.gitignore·README.md·bootstrap/·runtime/이다. git stage 작업은 수행하지 않았다.
