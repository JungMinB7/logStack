# AWS 고도화 기획서 (에이전트용) — plan-aws.md
 
> 이 문서는 AI 에이전트가 작업 전 읽는 기획 문서다. 사람이 결정을 내리면 갱신된다.
> 제출용 설계 문서는 docs/design-aws.md (별도), 기존 과제 문서 체계는 그대로 유지한다.
 
## 0. 프로젝트 목표
 
1차 면접 통과 후 고도화: 과제에서 "설계만" 했던 전송측을 **실제 AWS 인스턴스로 구현**하고,
전체 파이프라인을 Terraform 코드로 재현 가능하게 만든다.
 
핵심 가치 서열 (이 순서로 시간을 배분한다):
1. **전송측 실구현** — design.md §4(outbox, 1초 배칭, ACK 규칙, 백오프, 429 대응)를 코드로
2. **서버 rate limit 구현** — 과제의 미구현 한계(429 + Retry-After)를 해소
3. **Terraform IaC** — 전체 인프라를 코드로, spin-up/destroy 반복 가능
4. **TypeORM 전환** — 45개 e2e를 안전망으로 한 ORM 교체
5. HTTPS(ACM) + SSM 기반 무SSH 운영
## 1. 확정 아키텍처 (v1 검토 반영)
 
```
                        ┌─ VPC 10.0.0.0/16 (ap-northeast-2, 2 AZ) ─────────────┐
[동료/분석가]            │                                                        │
  │ https://<도메인>     │  퍼블릭 서브넷 ×2: NAT Gateway (1개)                    │
  ▼                     │    + 외부 ALB (ACM 인증서, 허용 IP 대역 제한)            │
(외부 ALB로 진입) ──────▶│      · GET /api/v1/metrics/* + 대시보드 정적만 포워드    │
                        │      · /event-batches 는 404 고정 (적재 경로 미노출)     │
[운영자]                 │                                                        │
  SSM 포트포워딩         │  프라이빗-앱 서브넷 ×2                                   │
                        │    전송 인스턴스 ×10 (t3.nano~micro)                    │
                        │      · sender 앱: 30명×0.5건/초 시뮬레이션               │
                        │      · outbox(로컬 파일) + 1초 배칭 + 순차 전송           │
                        │      · 자체 스로틀 60req/분 + 429 Retry-After 준수       │
                        │         │ HTTPS (Bearer 인스턴스별 키)                  │
                        │         ▼                                              │
                        │    [내부 ALB] ← ACM 인증서, TLS 종료, /health 체크        │
                        │         │ HTTP                                         │
                        │         ▼                                              │
                        │    수신 인스턴스 ×1 (t3.small)                          │
                        │      · 적재 API + 지표 5종 + rate limit(429) 구현        │
                        │      · 대시보드 정적 서빙 (T9, 외부 ALB 경유)             │
                        │         │ 5432                                         │
                        │  프라이빗-데이터 서브넷 ×2 (인터넷 경로 없음)              │
                        │    PostgreSQL EC2 ×1 (t3.medium, gp3 EBS)              │
                        │      · DLM 일일 스냅샷 + pg_dump 일일 timer 백업         │
                        └────────────────────────────────────────────────────────┘
Route53: ACM 검증 + 내부 도메인 → 내부 ALB (적재 전용)
        + 공개 도메인 → **외부 ALB** → 수신 (동료용 대시보드 + 지표 API만 라우팅)
SSM Parameter Store: API 키 10+1개 (SecureString)
CloudWatch Logs: sender/receiver 구조화 로그 수집
Terraform: S3 백엔드 + 전체 리소스 코드화
```
 
원안 대비 수정 사항 (v2 확정):
- ALB 위치: 전송 앞 → **수신 앞 internal ALB** (ALB는 받는 쪽 프록시. A-24의 TLS 종료 역할)
- v2: **외부 ALB 추가** — 동료가 보유 도메인으로 대시보드·지표를 조회. 적재 경로는
  리스너 규칙에서 404 고정으로 인터넷 미노출 (ALB 2개 역할 분리)
- 접근 수단: 배스천 없이 **SSM Session Manager** (SSH 키·인바운드 0)
- Public NAT Gateway 1개를 public-A에 배치 (앱 A/B의 HTTPS 아웃바운드). Regional NAT·NAT 다중화는 미채택
- DB는 인터넷 경로 없는 데이터 서브넷으로 격리

### T4 승인 보완 (2026-09-09)

사용자 후속 승인 원본과 확정/권고/미확인·실행 상태는 `infra/T4_STATUS.md`에 기록한다.
아래는 로컬 구현 승인이지 실제 계정의 AZ·CIDR 충돌 검증이나 AWS 배포 완료가 아니다.
리전은 ap-northeast-2, AZ 후보는 ap-northeast-2a/ap-northeast-2c다.
실제 일반 AZ·Endpoint 지원 및 기존 네트워크/VPN 중복을 확인한 뒤 고정하며, 불가하면 임의 대체하지 않는다.

| 서브넷 | 승인 CIDR | route table 연결 | 기본 경로 |
|---|---|---|---|
| public-A | 10.0.0.0/24 | public | 0.0.0.0/0 → IGW |
| public-B | 10.0.1.0/24 | public | 0.0.0.0/0 → IGW |
| app-A | 10.0.10.0/24 | app-A | 0.0.0.0/0 → public-A의 NAT |
| app-B | 10.0.11.0/24 | app-B | 0.0.0.0/0 → 같은 NAT |
| data-A | 10.0.20.0/24 | data-A | 인터넷 기본 경로 없음 |
| data-B | 10.0.21.0/24 | data-B | 인터넷 기본 경로 없음 |

모든 RT에는 VPC local 경로가 있으며 앱·데이터 RT에는 S3 Gateway Endpoint 경로를 연결한다.
EC2 퍼블릭 IP는 없다. NAT 단일 AZ의 장애·교차 AZ 비용 한계는 유지한다.

서비스 SG 5종의 체인 (관리 통신은 아래에서 별도 허용):
```
sender-sg:    인바운드 없음 / 서비스 아웃바운드 443 → int-alb-sg
int-alb-sg:   인바운드 443 ← sender-sg만 / 아웃바운드 3000 → receiver-sg
ext-alb-sg:   인바운드 443 ← 허용 IP 대역(회사·집)만 / 아웃바운드 3000 → receiver-sg
receiver-sg:  인바운드 3000 ← int-alb-sg, ext-alb-sg만 / 아웃바운드 5432 → db-sg
db-sg:        인바운드 5432 ← receiver-sg만 / 서비스 아웃바운드 없음
 
외부 ALB 라우팅 제한 (리스너 규칙):
- 허용: GET /api/v1/metrics/* 와 대시보드 정적 파일(/)만 수신으로 포워드
- 차단: /api/v1/event-batches 는 외부 ALB에서 404 고정 응답 — 적재 경로는 내부 전용
- 기본: 허용한 정적 파일·metrics GET 외 경로는 404. ADMIN 인증 유지, HTTP 80 추가 없음
```

관리용 vpce-sg 1종을 추가하여 총 6종으로 한다. SG와 개별 규칙을 분리하여 상호 참조 순환을 피한다.

| 출발지 | 관리 egress / 목적지 | 정책 |
|---|---|---|
| sender/receiver/db SG | TCP 443 → vpce-sg | ssm/ssmmessages/logs 관리 통신 |
| vpce-sg | 위 3개 EC2 SG에서 TCP 443 ingress | SSM용 EC2 인바운드나 SSH는 열지 않음 |
| sender/receiver SG | TCP 443 → 0.0.0.0/0 (앱 NAT 경유) | 승인된 외부 HTTPS 공급. 도메인 allowlist가 아니며 공개 ingress 승인이 아님 |
| 필요한 EC2 SG | TCP 443 → 서울 S3 관리형 prefix list | S3 Gateway 경유, IAM·Endpoint 정책으로 승인 버킷/경로 제한 |
| DB | 인터넷 목적지 egress 없음 | 임시 IGW/NAT 경로·HTTP 80·전체 포트 개방 금지 |

ssm/ssmmessages/logs Interface Endpoint는 앱 2 AZ에 배치하고 VPC DNS·Private DNS를 사용한다.
S3 Gateway Endpoint는 앱·데이터 RT에 연결한다. 추가 ec2messages/KMS Endpoint는 필요 근거와 별도 승인 대상이다.
T4 SSM IAM 기반에는 비밀값 조회 권한을 관성적으로 넣지 않는다. 후속 역할별 이름/ARN·권한을 정하고
실제 비밀값은 인스턴스 런타임에서 조회한다. 광범위 Allow에 좁은 Allow를 추가해 권한이 제한됐다고 간주하지 않는다.
T5 후속 승인(2026-09-09): 공식 AL2023 고정 AMI + 고정 버전 S3 repository에서 user_data로 PG16을 설치한다.
서울 AMI `ami-080417beadd39ca40`(Amazon owner `137112412989`, x86_64), release `2023.12.20260831`을 고정한다.
공식 이미지의 SSM Agent와 chrony를 설치 단계에서 고정 패키지 버전·서비스 상태로 확인한다.
S3 Gateway 정책은 `al2023-repos-ap-northeast-2-de612dc2`의 고정 GUID metadata와 종속성 공급용 `blobstore/` GetObject만 허용한다.
공개 repository의 unsigned GET과 DB 역할의 백업 PutObject 권한을 구분하며 RPM·metadata GPG 검증을 적용한다.
사전 준비 custom AMI/S3 offline bundle은 직접 공급 실패 시 별도 승인받을 대안으로 유지한다.
이미지 빌더·새 AMI·DB 임시 인터넷 경로는 만들지 않는다. 실제 EC2 설치 성공은 사람 apply 후 검증 대상이다.
외부 CIDR은 아직 미입력이다. T4 ext-alb-sg ingress는 비워 두고 T9 전에 실제 승인 CIDR을 받는다.
 
## 2. 사람이 결정해야 확정되는 것 (T0 블로커)
 
| # | 결정 | 선택지 | 기본 권고 |
|---|---|---|---|
| D1 | 도메인 | ✅ **확정: 보유 도메인 사용** (ACM 검증 + 외부/내부 레코드) | — |
| D2 | 리전 | 확정: ap-northeast-2 (서울) | AZ a/c 후보의 계정 지원은 미확인 |
| D3 | 운용 방식 | 확정: 면접 시연 48~72시간 후 사람이 runtime destroy | 금액 상한·72시간 연속 이벤트 생성 승인은 아님 |
| D4 | TypeORM 전환 이유 | 회사 스택 정렬 / 학습 | 회사 스택 정렬로 답변 준비 |
| D5 | 배포 방식 | user_data 초기 설정 유지 | 앱은 HTTPS 공급, T5 DB는 공식 고정 AL2023 + 고정 S3 repo 설치 승인. custom AMI/offline은 대안, Docker/ECR 자동 전환 없음 |
| D6 | 리포 구조 | 확정: 기존 리포에 infra/ | infra/bootstrap과 infra/runtime 분리 |
 
48/72시간 비용은 `infra/T4_STATUS.md`의 서울 공식 단가·시간·수량·미확인 표를 기준으로 한다.
기존 시간당 $0.25~0.30/월 20만원대는 Endpoint·공인 IPv4 등 근거가 부족한 과거 추정이며 확정 견적이 아니다.
기존 타입은 sender t3.nano×10 + receiver/DB t3.small 각1이다. 권고 비용 시나리오는 receiver/DB t3.medium 각1,
sender nano~micro×10 유지다. T5 DB만 t3.medium/CPU Standard로 확정했으며 receiver/sender 타입은 후속 단계에서 확인한다. t3.medium×12로 확정하지 않는다.
Project 기본값 logstack-demo, Environment demo를 채택한다. 기존 확정 태그는 검색 범위에서 발견되지 않았다.
T4를 일찍 apply하면 면접 외 대기 시간에도 NAT·EIP·Endpoint 유지 비용이 발생한다.

상태 backend가 실제 확인되면 기존 버킷/key/잠금을 안전하게 재사용한다. 존재·권한은 아직 미확인이다.
없으면 bootstrap에서 버전 관리·공개 차단·암호화·HTTPS 강제·삭제 보호·force_destroy=false의 상태 S3를
사람이 최초 apply한다. 신규 backend는 Terraform 1.10 이상에서 S3 use_lockfile=true, 신규 DynamoDB 없음.
bootstrap 최초 상태는 로컬에 안전하게 보관하고, 명시적으로 승인한 후속 이전만 허용한다.
runtime은 준비된 backend를 사용한다. 상태 버킷·기존 도메인/Hosted Zone·공유 자원은 runtime destroy 대상이 아니다.
15분 재현은 최초 도구/로그인/backend/시크릿/도메인/AMI 준비와 구분한 반복 runtime의 T8 검증 목표다.
최초 사람 apply와 보존·삭제 절차는 `infra/TEARDOWN.md` 및 단계 상태 기록을 따른다.
 
## 3. 작업 단계 (T0~T8)
 
각 단계는 기존 방식대로 "프롬프트 → 완료 보고 → 사람 검토 → 커밋" 루프로 진행한다.
 
| 단계 | 내용 | 완료 조건 |
|---|---|---|
| T0 | D1~D6 결정, 리포 구조 생성(infra/, sender/), AI_RULES에 인프라 규칙 추가 | 결정 표 채움, 커밋 |
| T1 | **TypeORM 전환** (src/의 repository 계층만 교체) | **기존 e2e 45개 무수정 전부 green**, CHECK 제약·인덱스가 마이그레이션에 동일 재현 |
| T2 | **서버 rate limit 구현**: 인스턴스(키)별 120회/분 고정 창, 429 + Retry-After | e2e 추가: 121번째 요청 429, Retry-After 헤더, 창 리셋 후 200 |
| T3 | **sender 앱 구현** (sender/): 이벤트 생성기(30명×0.5건/초) + outbox(파일) + 1초/500건/3MB 배칭 + 순차 전송 + §4.2 ACK 표 전체 + 지수 백오프 + 429 대기 + 60req/분 자체 스로틀 | 로컬에서 receiver 상대로 30분 무유실 가동, 강제 kill 후 재시작 시 outbox에서 이어서 전송, **drain 검증**: outbox에 5,000건을 쌓아둔 채 시작 → 최대 배치(500건)로 묶어 자체 스로틀 한도 내 최단 시간 소화 |
| T4 | Terraform 네트워크: VPC, 서브넷 6개, IGW/Public NAT1+EIP, 서비스 SG5+관리 SG1, SSM IAM/Endpoint, 분리된 S3 backend | 각 실행 루트 validate + 실제 plan 독립 리뷰 통과. 코드/정적 검사만으로 완료 아님 |
| T5 | Terraform DB: 공식 고정 AL2023 EC2 + S3 repo user_data PG16 설치·초기 설정, gp3 EBS, DLM 일일 스냅샷(최근3개)·S3 일일 pg_dump(7일), chrony | DB 자체 점검 후 T6 receiver 생성에 의존하는 receiver psql 접속을 반드시 확인. 원래 검증 생략 없음 |
| T6 | Terraform 수신: EC2 + user_data 배포, 내부 ALB + ACM + Route53, SSM 파라미터에서 키 주입 | SSM 포트포워딩으로 /health 200, 적재 curl 성공 |
| T7 | Terraform 전송: count=10 인스턴스, 인스턴스별 키 매핑, systemd 서비스로 sender 가동 | CloudWatch에서 10대 전송 로그, DB에 유입 확인 |
| T8 | **실측·시연·문서화**: AWS 위에서 load-check 재실행 + **장애 시나리오 3종 시연** — A) 수신 서버 60초 정지 → outbox 적체 → 재기동 후 drain, B) DB만 정지 → 503(재시도 대상) → 백오프 재전송 → 복구, C) 429 발동(1대 스로틀 해제 → Retry-After 대기 → 재개). 각 시나리오에서 생성 총건수 = DB 저장 건수, 유실 0 검증. 다이어그램, README-aws, destroy→apply 리허설 | infra-audit 통과, 15분 내 재현, 시나리오 3종 결과 기록 |
| T9 | **동료용 대시보드**: 외부 ALB + 보유 도메인(Route53/ACM), 수신 서버 ServeStatic으로 정적 1페이지(DAU 라인차트, 매출·전환율 카드, 리텐션 표, 참여율 히트맵). metrics API만 호출(지표 정의 단일 창구 유지), ADMIN 키 입력 방식 | 도메인 접속으로 지표 5종 표시, 외부 ALB에서 적재 경로 미노출(404) 확인 |
 
## 4. 에이전트·스킬 구성 (기존 체계 확장)
 
### 유지 (그대로 사용)
- **backend-developer**: T1(TypeORM), T2(rate limit), T3(sender 앱) 담당
- **architecture-reviewer / metrics-reviewer / docs-auditor**: 기존 역할 그대로
  (T1 후 metrics-reviewer로 지표 회귀 확인 필수)
