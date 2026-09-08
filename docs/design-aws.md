# 게임 로그 파이프라인 — AWS 배포 설계 문서 (제출용 초안) — design-aws.md
 
> 과제 제출본(docs/design.md)의 후속 문서. 과제에서 설계로만 남겼던 전송측을 실제
> 인스턴스로 구현하고, 전체 인프라를 Terraform으로 코드화한 기록이다.
> [TBD] 표시는 결정 대기 항목 (plan-aws.md D1~D6).
 
## 1. 목표와 범위
 
과제 설계 문서의 세 가지 "범위 외"를 실물로 만든다.
 
1. **전송측(게임 인스턴스) 실구현**: design.md §4의 outbox·배칭·ACK 규칙·백오프를
   실제 EC2 10대에서 가동한다. 인스턴스당 30명 × 평균 0.5건/초의 이벤트를 시뮬레이션한다.
2. **서버 측 rate limit 구현**: 과제에서 미구현 한계로 명시했던 429 + Retry-After를
   구현하고, 실제 한도 초과 상황을 유도해 전송측의 대응(대기 후 재개)까지 시연한다.
3. **인프라의 코드화(IaC)**: VPC부터 인스턴스까지 Terraform으로 작성하여
   destroy → apply 만으로 전체 환경이 재현됨을 보인다.
부가 변경: ORM을 Prisma에서 TypeORM으로 전환한다. 기존 e2e 45개를 무수정으로 유지한 채
저장 계층만 교체하여, 3층 구조(저장 접근의 Repository 격리)가 실제로 교체 비용을
낮췄음을 실증한다. [사유: TBD-D4]
 
## 2. 전체 아키텍처
 
과제 설계의 논리 구조를 AWS 리소스로 1:1 매핑했다.
 
| 과제 설계 (design.md) | AWS 구현 |
|---|---|
| 게임 인스턴스 ×10~300 (설계만) | EC2 전송 인스턴스 ×10 (sender 앱, systemd) |
| TLS 종료 프록시 [A-24] | 내부(internal) ALB + ACM 인증서 |
| 적재 서버 (NestJS) | EC2 수신 인스턴스 ×1 |
| PostgreSQL | EC2 + gp3 EBS (RDS 미사용, ADR-003) |
| 인스턴스별 API 키 [A-21] | SSM Parameter Store (SecureString) ×11 |
| 구조화 로그 (§6.5) | CloudWatch Logs (에이전트 수집) |
| 동료용 지표 조회 (신규) | 외부 ALB + 보유 도메인(Route53/ACM) + 수신 서버 정적 대시보드 |
 
네트워크 구성 (VPC 10.0.0.0/16, 서울 리전, 2 AZ):
 
- **퍼블릭 서브넷 ×2**: NAT Gateway (프라이빗 인스턴스의 아웃바운드 전용) + **외부 ALB**
  (동료용 — ACM 인증서, 허용 IP 대역 제한, GET /api/v1/metrics/*와 대시보드 정적만 포워드)
- **프라이빗-앱 서브넷 ×2**: 전송 ×10, 내부 ALB, 수신 ×1
- **프라이빗-데이터 서브넷 ×2**: PostgreSQL EC2 — **인터넷 라우트 자체가 없음**
트래픽 흐름:
 
```
전송 인스턴스 ×10 ──HTTPS(Bearer 인스턴스별 키)──▶ 내부 ALB ──HTTP──▶ 수신 인스턴스 ──5432──▶ PostgreSQL
     ▲                                                                        │
     └── 429 Retry-After / 응답 파싱 후 outbox 정리                  CloudWatch Logs
동료: https://<도메인> → 외부 ALB(IP 대역 제한) → 수신 [대시보드 정적 + GET /api/v1/metrics/* 만]
     · 적재 경로(/event-batches)는 외부 ALB 리스너 규칙에서 404 고정 — 인터넷 미노출
운영자(인프라 작업): SSM Session Manager 포트포워딩 (SSH·배스천 없음)
```
 
## 3. 보안 설계
 
**원칙: EC2는 인터넷에 직접 공개하지 않는다. 외부 ALB만 승인 CIDR에 제한된 HTTPS 접근을 제공한다.**
 
- 모든 인스턴스는 퍼블릭 IP 없음. 운영 접근은 SSM Session Manager(SSH 키·배스천·인바운드
  포트 전무). 감사 로그가 CloudTrail에 남는 부수 효과
- 보안 그룹 최소 권한 체인: sender→(443)→ALB→(3000)→receiver→(5432)→DB.
  서비스 간 규칙은 **앞 단계 SG 참조**로 허용한다. 외부 ALB의 승인 CIDR ingress는 명시적 예외이며
  어떤 SG에도 0.0.0.0/0·::/0 ingress를 허용하지 않는다. 실제 CIDR 미입력 시 외부 ALB SG ingress는 비워 둔다.
- 인증 이중화: 전송 구간은 ALB의 TLS + 애플리케이션의 Bearer 키·instance_id 일치 검증
  (과제 §5.4 그대로). 키는 SSM SecureString에서 부팅 시 주입, 코드·AMI에 미포함
- DB 계정은 애플리케이션 전용 계정 분리, 수퍼유저 원격 접속 차단

### T4 네트워크·관리 통신 승인 (2026-09-09)

정확한 서비스 SG5+vpce-sg1, 승인된 6개 CIDR/RT 및 관리 통신 표는 plan-aws.md §1과
infra/T4_STATUS.md를 따른다. AZ a/c는 후보이며 실제 계정의 일반 AZ·서비스 지원·CIDR 충돌은 미확인이다.
Public NAT1은 public-A, app-A/B 기본 경로는 같은 NAT, 데이터 RT에는 인터넷 기본 경로가 없다.
ssm/ssmmessages/logs Interface Endpoint를 앱 2 AZ에 배치하고 VPC DNS·Private DNS를 사용한다.
S3 Gateway Endpoint는 앱·데이터 RT에 연결한다. ec2messages/KMS 등 추가 Endpoint는 별도 근거·승인 대상이다.
서비스 egress와 별도로 EC2 SG→vpce-sg TCP443, 필요한 EC2 SG→S3 prefix list TCP443을 허용한다.
sender/receiver의 외부 패키지 공급은 NAT 경유 0.0.0.0/0 TCP443 egress를 허용한다.
이는 도메인별 제한이 아니며 ingress 공개 승인이 아니다. HTTP80·전체 포트 egress를 추가하지 않는다.
DB는 Endpoint·승인된 S3 경로만 사용한다. PG16·SSM Agent·chrony가 준비된 신뢰 가능한 AMI를 우선하되
AMI 존재·ID·제작/공급 비용·재현 절차는 T5 전에 확인한다. 없으면 S3 오프라인 대안을 별도 승인받는다.
T4에 빌더 EC2·새 AMI·Image Builder 또는 DB 임시 인터넷 경로를 만들지 않는다.
T4 IAM은 관리 기반만 다루고 비밀값 조회를 관성적으로 허용하지 않는다. 후속 역할별 이름/ARN·최소 권한을 정해
인스턴스 런타임에서 조회하며 Terraform은 실제값을 읽거나 저장하지 않는다.
## 4. 전송측(sender) 구현 명세 — 과제 §4의 실현
 
sender 앱은 design.md §4를 코드로 옮긴 것이다. 핵심 동작:
 
1. **이벤트 생성**: 가상 유저 30명이 평균 0.5건/초 [A-5] 를 따르도록 이벤트 생성
   (로그인/사냥/결제 비율은 과제 생성기 분포 재사용)
2. **outbox 선기록**: 생성 즉시 로컬 파일 outbox에 append(fsync) — 프로세스가 죽어도
   미전송 로그 보존 [A-26]. 재시작 시 outbox부터 이어서 전송 (T3 완료 조건으로 검증)
3. **배칭·전송**: 1초 / 500건 / 3MB 중 먼저 도달하는 조건에서 전송. in-flight 1 순차 [A-25]
4. **자체 스로틀**: 60 req/분 (한도 120의 50%, §2.1) — 서버 429는 최후 방어선일 뿐,
   1차 준수 책임은 전송측에 있다
5. **ACK 처리**: HTTP 상태가 아닌 **응답 본문 파싱** 후 stored/duplicate/order_duplicate만
   outbox에서 삭제, rejected는 실패 저장소 격리, 파싱 실패는 전체 재전송 (§4.2 표 전체 구현)
6. **오류 대응**: 5xx·timeout 지수 백오프 재전송, 429는 Retry-After + jitter 대기,
   401/403은 전송 중지 + 로그 경보, 413은 배치 이분할

### 고정 창과 재시작 한계 (T3 보완)

sender와 receiver T2 모두 각 프로세스의 `Date.now()`를 epoch 60초 경계로
내린 고정 창을 사용한다. 두 호스트 시계가 어긋나면 실제 경계도 어긋난다.
시계가 정상 진행하고 한 sender만 동작하며 재시작이 없다면 정렬된 창당
L(기본 60)회 이하이나, 인접 두 창을 걸친 짧은 구간에는 최대 2L회가 몰릴 수 있다.
sender 카운터는 메모리 상태다. 같은 정렬 창 안에서 정확히 한 번 재시작하면
해당 창에서 최대 2L, k번 재시작하면 최대 (k+1)L회가 가능하다. 반복 재시작
횟수에 제한이 없으므로 **같은 분 최대 120회라는 무조건적 상한은 없다**.
같은 키의 다중 sender나 시계 역행도 위 단일 프로세스 조건 밖이다.
receiver 카운터 역시 재시작 시 초기화된다. 리미터 알고리즘은 변경하지 않았다.

T2의 429는 최후 방어선이며 sender의 1차 한도 준수 책임을 대체하지 않는다.
429에서 outbox/체크포인트를 보존하고 Retry-After+jitter 이후 같은 event_id를
재전송하는 것은 복구 수단이다. **429가 발생했다는 사실만으로 유실 0을 증명하지 않는다.**
최종 drain 이후 독립 기록 성공 ID 집합과 DB 원본/실패 저널 집합의 정합 및
미확정 outbox 0을 별도로 검증해야 한다.

## 5. 서버 측 rate limit (구현됨 — T2)
 
- 키(=인스턴스) 단위 고정 1분 창 [A-25], 한도 120회/분 (env `RATE_LIMIT_PER_MINUTE`)
- 초과 시 429 + `Retry-After: <창 리셋까지 초>` — 과제 OpenAPI에 계약으로만 있던 것을 구현
- 적재 경로 전용, 인증(401/403) 통과 후 판정 — 무효 키는 카운터를 소모하지 않음
- 저장소는 인메모리 Map(수신 1대 전제) — 수신 다중화 시 분산 rate limit 필요 (design.md §15)
- 429 발생 시 구조화 로그(키 지문·창 내 요청 수·남은 초) — §10 시나리오 C의 관측 재료
- 시연 시나리오: 전송 1대의 자체 스로틀을 의도적으로 해제 → 서버 429 발동 →
  전송측이 Retry-After만큼 대기 후 재개, **유실 0건**(outbox 보존) 확인
## 6. 저장소 결정 — ADR-003: RDS 대신 EC2 PostgreSQL
 
**결정**: PostgreSQL 16을 EC2에 직접 설치·운영한다.
 
**근거**: ① 비용 — 동급 RDS 대비 인스턴스 비용이 낮고, 데모 시에만 가동하는 운용(D3)과
맞음 ② 학습 — RDS가 자동화해주는 것(백업, 패치, 파라미터, 장애 복구)을 직접 구현하며
그 가치를 체감하는 것이 목적의 일부
 
**감수하는 것**: 관리형 서비스가 제공하는 자동 페일오버·시점 복구 없음. 대응으로
gp3 EBS + 일일 스냅샷 + pg_dump cron(주기 [TBD])을 직접 구성하고, 이 운영 부담이
곧 "실서비스라면 RDS를 선택할 이유"임을 인정한다.
 
## 7. 배포 재현성 — ADR-004: Terraform 전면 코드화
 
- 상태: 기존 backend 존재·접근·잠금을 먼저 확인하여 재사용. 없으면 infra/bootstrap과 infra/runtime 분리
- 리소스: VPC/서브넷/라우트/IGW/NAT/SG/IAM/SSM/EC2/ALB/ACM/Route53/CloudWatch 전부 코드
- 인스턴스 초기화는 user_data 스크립트 (Node 설치, 코드 배포, systemd 등록) [D5]
- 최초 준비: 도구·로그인·상태 버킷·시크릿·기존 도메인/Zone·DB AMI 공급은 별도 사람 준비 단계다.
  신규 bootstrap은 로컬 상태로 시작하며 존재하지 않는 자기 버킷을 backend로 참조하지 않는다.
  버전 관리·공개 차단·암호화·HTTPS 강제·삭제 보호·force_destroy=false를 적용하고 사람만 최초 apply한다.
  로컬 상태를 안전하게 보관하며 원격 이전·기존 잠금 교체는 자동 실행하지 않는다.
  신규 runtime backend는 S3 use_lockfile=true(지원 Terraform 1.10 이상), 신규 DynamoDB 없음.
- 완료 목표: 위 준비·보존 자원이 있는 반복 runtime destroy/apply에서 15분 내 파이프라인 재가동,
  반복 부트스트랩 수동 설정 0개를 T8에서 실제 검증한다. 최초 준비나 사람의 apply/destroy 자체를 없앤다는 뜻이 아니다.
- 상태 버킷·기존 도메인/Hosted Zone·공유 자원은 runtime 수명주기에서 제외한다.
  T5의 receiver psql 확인은 T6 receiver 생성에 의존한다. DB 자체 점검과 구분하고 원래 연결 검증은 반드시 수행한다.
- 에이전트 안전 규칙: AI는 plan까지만, apply/destroy는 사람이 실행 (AI_RULES 28)
## 8. ORM 전환 — ADR-005: Prisma → TypeORM
 
**결정**: 저장 계층(Repository)의 Prisma 코드를 TypeORM으로 교체한다. [사유 확정: TBD-D4]
 
**방법**: 테스트를 단 하나도 수정하지 않고 진행한다. 기존 e2e 45개가 API 계약·지표
정확성·멱등성을 전부 잠그고 있으므로, 전환 후 전량 green이면 동작 동일성이 증명된다.
 
**유지하는 것**: 집계 SQL은 raw 그대로(ORM 재작성 금지), CHECK 제약·인덱스는
마이그레이션 SQL로 동일 재현, ON CONFLICT + RETURNING 패턴 유지.
 
**이 전환이 증명하는 것**: 과제에서 3층 구조를 선택하며 "DB 접근을 Repository에 격리해
교체 지점을 확보했다"고 문서화했는데(ADR-002), 그 주장의 실증이다.
 
## 9. 관측과 운영
 
- CloudWatch Logs: sender·receiver의 구조화 로그(배치 카운터, 지연, 429 발생) 수집
- 시계 동기화: 전 인스턴스 chrony — occurred_at 정확성의 전제 [A-3]를 인프라로 보장
- 백업: EBS 일일 스냅샷 + pg_dump cron, 복구 리허설 1회 수행 후 절차 문서화
- 비용 통제: 지원 리소스에 Project=logstack-demo, Environment=demo (기존 확정 태그 미발견).
  면접 시연 48~72시간 후 사람이 runtime을 destroy한다. 72시간은 금액 상한·연속 이벤트 생성 승인이 아니다.
  T4 및 최종 구성의 48/72시간 비용·서울 단가·미확정은 infra/T4_STATUS.md, 보존/삭제는 infra/TEARDOWN.md에 기록한다.
  기존 sender nano×10/receiver·DB small 각1과 권고 sender nano~micro×10/receiver·DB medium 각1을 구분한다.
  역할별 타입·CPU credit Standard/Unlimited·용량은 T5/T7 전에 확인하며 12대 전체 medium으로 확정하지 않는다.
  NAT·EIP·Endpoint는 시연 전 개발 대기 중에도 유지 과금된다. 보존 S3·snapshot·AMI·로그·DNS 잔존 비용도 별도 점검한다.
## 10. 실측 계획 (§10.7 정직성 원칙 유지)
 
- AWS 환경에서 load-check 재실행: 이론 상한 20 req/s → 성공률·p50/p95, 로컬 대비 비교
- **장애 시나리오 3종** (각각 "생성 총건수 = DB 저장 건수, 유실 0"을 판정 기준으로):
  - A. 수신 서버 다운: sender 10대 가동 중 수신 60초 정지 → outbox 적체 관찰 →
    재기동 → drain 소요 시간 측정 (§2.2 계산치와 대조: 만석 기준 4,500건 ≈ 9배치 ≈ 9초)
  - B. DB만 다운: 수신은 503(재시도 대상) 반환 → 전송측 지수 백오프 → DB 복구 후 정합 검증
    (P2028/P1001 → 503 매핑의 실전 동작 확인)
  - C. 서버 rate limit 발동: 1대의 자체 스로틀 해제 → 429 + Retry-After → 대기 후 재개
- sender 강제 종료 → 재시작 후 outbox 이어서 전송 시연 (T3 완료 조건의 AWS 재확인)
- 모든 수치는 실제 실행 결과만 기재하며, 이 규모의 실측이 운영 보장이 아님을 명시
## 11. 동료용 대시보드 — ADR-006: 자체 프론트 (Grafana 직결 대신)
 
**결정**: 동료(운영진·분석가)가 보유 도메인으로 접속하는 정적 대시보드 1페이지를
수신 서버가 함께 서빙한다(NestJS ServeStatic). 데이터는 **metrics API만 호출**한다.
 
**근거**: Grafana를 PostgreSQL에 직결하면 지표 정의(교집합 분자, matured null,
반개구간, summary 재계산)를 Grafana 쿼리에 **이중 구현**하게 되어, API와 대시보드의
숫자가 어긋날 위험이 생긴다. metrics API를 유일한 지표 창구로 유지하는 것이
이 시스템의 설계 원칙이며, 대시보드는 그 API의 첫 실사용 소비자다.
 
**범위**: DAU 라인차트, 매출/전환율 카드, 리텐션 코호트 표, 참여율 히트맵 — 1페이지.
인증은 ADMIN 키 입력 → Bearer 헤더. 시스템 관측(429율, 배치 시간)은 CloudWatch로
충분하며, Prometheus/Grafana는 관측 고도화의 선택 항목으로 남긴다.
 
**외부 노출 통제**: 외부 ALB는 IP 대역 제한 + 리스너 규칙으로 GET /api/v1/metrics/*와
정적 파일만 포워드하고, 적재 경로는 404 고정 응답한다. 적재는 내부 ALB 전용.

T6/T9 인계: 기존 public Hosted Zone·보유 도메인을 재사용하되 소유권/권한/위임을 실제 확인한다.
미사용 dashboard.<보유 도메인>을 권고하며 FQDN·Zone ID·접속 CIDR은 아직 미입력이다.
기존 Zone·등록 도메인을 runtime에 통째로 import하거나 apex/www/MX/NS/TXT를 덮어쓰지 않는다.
T9 전용 Alias→외부 ALB→receiver, 같은 리전 ACM+DNS 검증을 사용한다. 공유 검증 레코드는 전용 삭제 대상으로 오인하지 않는다.
HTTPS443만 열며 HTTP80 리다이렉트·TLS 검증 우회(-k)는 추가하지 않는다. 정적 파일·metrics GET 외 기본 응답 및
정확한 /api/v1/event-batches는 404, ADMIN 인증은 유지한다. SG만으로 URL 차단을 구현했다고 보고하지 않는다.
내부 적재 TLS/DNS는 T6, 외부 HTTPS·화면 실측은 T9 완료 조건이며 T4에서는 해당 리소스를 만들지 않는다.
 
## 12. 한계
 
- 수신 인스턴스 1대 (단일 장애점) — ALB 뒤 다중화는 확장 방안으로 남김
  (적재는 멱등성 덕에 수평 확장이 안전함을 §6 근거로 서술)
- PostgreSQL 단일 노드 — 복제·페일오버 없음 (ADR-003에서 인정한 비용)
- NAT 단일 AZ — 비용 절약 선택, AZ 장애 시 아웃바운드 상실
- 대시보드 인증은 ADMIN 키 단일 공유 — 다인 사용 시 사용자별 계정·권한(예: Cognito)이
  필요하며 확장 방안으로 남김. IP 대역 제한이 1차 방어
- D1은 보유 도메인 사용으로 확정됐다. 자체 서명 인증서·전송측 TLS 검증 예외는 채택하지 않는다.
