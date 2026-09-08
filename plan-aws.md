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
                        │    PostgreSQL EC2 ×1 (t3.small, gp3 EBS)               │
                        │      · EBS 스냅샷 + pg_dump cron 백업                   │
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
- NAT Gateway 1개 추가 (프라이빗 인스턴스 부트스트랩용 아웃바운드)
- DB는 인터넷 경로 없는 데이터 서브넷으로 격리
보안 그룹 체인 (최소 권한):
```
sender-sg:    인바운드 없음 / 아웃바운드 443(int-alb-sg), 443(SSM·패키지)
int-alb-sg:   인바운드 443 ← sender-sg만 / 아웃바운드 3000 → receiver-sg
ext-alb-sg:   인바운드 443 ← 허용 IP 대역(회사·집)만 / 아웃바운드 3000 → receiver-sg
receiver-sg:  인바운드 3000 ← int-alb-sg, ext-alb-sg만 / 아웃바운드 5432 → db-sg
db-sg:        인바운드 5432 ← receiver-sg만 / 아웃바운드 없음(패키지 설치 시 임시)
 
외부 ALB 라우팅 제한 (리스너 규칙):
- 허용: GET /api/v1/metrics/* 와 대시보드 정적 파일(/)만 수신으로 포워드
- 차단: /api/v1/event-batches 는 외부 ALB에서 404 고정 응답 — 적재 경로는 내부 전용
```
 
## 2. 사람이 결정해야 확정되는 것 (T0 블로커)
 
| # | 결정 | 선택지 | 기본 권고 |
|---|---|---|---|
| D1 | 도메인 | ✅ **확정: 보유 도메인 사용** (ACM 검증 + 외부/내부 레코드) | — |
| D2 | 리전 | ap-northeast-2 (서울) | 서울 |
| D3 | 운용 방식 | 상시 vs 데모 시에만 spin-up | **데모 시에만** (destroy 습관화) |
| D4 | TypeORM 전환 이유 | 회사 스택 정렬 / 학습 | 회사 스택 정렬로 답변 준비 |
| D5 | 배포 방식 | user_data 스크립트 vs Docker+ECR | user_data + git clone (단순) → 여유 시 Docker |
| D6 | 리포 구조 | 기존 리포에 infra/ vs 별도 리포 | 기존 리포에 infra/, sender/ 추가 (모노리포) |
 
예상 비용 (서울, 시간당 가동 기준): 전송 t3.nano×10 + 수신·DB t3.small×2 + ALB + NAT
≈ 시간당 약 $0.25~0.30. **상시 켜두면 월 20만원대 → D3=데모 시에만을 강력 권고.**
terraform destroy → apply 재현이 15분 안에 되는 것 자체가 IaC의 증명이다.
 
## 3. 작업 단계 (T0~T8)
 
각 단계는 기존 방식대로 "프롬프트 → 완료 보고 → 사람 검토 → 커밋" 루프로 진행한다.
 
| 단계 | 내용 | 완료 조건 |
|---|---|---|
| T0 | D1~D6 결정, 리포 구조 생성(infra/, sender/), AI_RULES에 인프라 규칙 추가 | 결정 표 채움, 커밋 |
| T1 | **TypeORM 전환** (src/의 repository 계층만 교체) | **기존 e2e 45개 무수정 전부 green**, CHECK 제약·인덱스가 마이그레이션에 동일 재현 |
| T2 | **서버 rate limit 구현**: 인스턴스(키)별 120회/분 고정 창, 429 + Retry-After | e2e 추가: 121번째 요청 429, Retry-After 헤더, 창 리셋 후 200 |
| T3 | **sender 앱 구현** (sender/): 이벤트 생성기(30명×0.5건/초) + outbox(파일) + 1초/500건/3MB 배칭 + 순차 전송 + §4.2 ACK 표 전체 + 지수 백오프 + 429 대기 + 60req/분 자체 스로틀 | 로컬에서 receiver 상대로 30분 무유실 가동, 강제 kill 후 재시작 시 outbox에서 이어서 전송, **drain 검증**: outbox에 5,000건을 쌓아둔 채 시작 → 최대 배치(500건)로 묶어 자체 스로틀 한도 내 최단 시간 소화 |
| T4 | Terraform 네트워크: VPC, 서브넷 6개, IGW/NAT, SG 4종, SSM용 IAM/엔드포인트, S3 백엔드 | terraform validate + plan 리뷰 통과 |
| T5 | Terraform DB: EC2 + user_data(PostgreSQL 16 설치·초기화), gp3 EBS, 스냅샷·pg_dump 백업, chrony | receiver에서 psql 접속 확인 |
| T6 | Terraform 수신: EC2 + user_data 배포, 내부 ALB + ACM + Route53, SSM 파라미터에서 키 주입 | SSM 포트포워딩으로 /health 200, 적재 curl 성공 |
| T7 | Terraform 전송: count=10 인스턴스, 인스턴스별 키 매핑, systemd 서비스로 sender 가동 | CloudWatch에서 10대 전송 로그, DB에 유입 확인 |
| T8 | **실측·시연·문서화**: AWS 위에서 load-check 재실행 + **장애 시나리오 3종 시연** — A) 수신 서버 60초 정지 → outbox 적체 → 재기동 후 drain, B) DB만 정지 → 503(재시도 대상) → 백오프 재전송 → 복구, C) 429 발동(1대 스로틀 해제 → Retry-After 대기 → 재개). 각 시나리오에서 생성 총건수 = DB 저장 건수, 유실 0 검증. 다이어그램, README-aws, destroy→apply 리허설 | infra-audit 통과, 15분 내 재현, 시나리오 3종 결과 기록 |
| T9 | **동료용 대시보드**: 외부 ALB + 보유 도메인(Route53/ACM), 수신 서버 ServeStatic으로 정적 1페이지(DAU 라인차트, 매출·전환율 카드, 리텐션 표, 참여율 히트맵). metrics API만 호출(지표 정의 단일 창구 유지), ADMIN 키 입력 방식 | 도메인 접속으로 지표 5종 표시, 외부 ALB에서 적재 경로 미노출(404) 확인 |
 
## 4. 에이전트·스킬 구성 (기존 체계 확장)
 
### 유지 (그대로 사용)
- **backend-developer**: T1(TypeORM), T2(rate limit), T3(sender 앱) 담당
- **architecture-reviewer / metrics-reviewer / docs-auditor**: 기존 역할 그대로
  (T1 후 metrics-reviewer로 지표 회귀 확인 필수)