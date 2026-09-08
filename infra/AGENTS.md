# infra/ 작업 지침

## 기준과 권한

- 루트 AGENTS.md의 필수 읽기 순서와 AI_RULES.md를 따르고, plan-aws.md,
  docs/design-aws.md, 현재 단계 승인 기록(T4는 T4_STATUS.md)을 읽는다.
- 2026-09-09 T4 후속 사용자 요청은 승인된 T4 로컬 구현만의 예외다.
  저장소 전체 구현 권한이나 AWS 배포 허가가 아니다. 이 파일은 실제 샌드박스·권한을 대체하지 않는다.
- 메인이 최초 지침·승인/대기 기록을 정리한다. Terraform 구현은 infra-developer 단일 작성자다.
  메인과 동시 쓰기 금지. 리뷰어는 읽기 전용이며 자식의 재위임은 금지한다.
  동시 자식은 현재 설정 한도 내 최대 2명. 모든 위임 대상도 이 파일을 직접 읽는다.
- 2026-09-09 T4 재개 요청에 한해 독립 사전검토 미완료여도 승인된 로컬 Terraform 코드를 작성한다.
  infra-developer 호출 불가 시 동일 지침을 전달한 일반 자식 1명, 그것도 불가하면 메인이 유일 작성자가 된다.
  infra-reviewer 호출 불가 시 구현에 참여하지 않은 새 일반 자식에 동일 검토 지침과 infra-audit를 전달한다.
  대체 위임은 등록 복구가 아니며, 독립 코드·실제 plan 검토 미완료 상태는 T4 완료가 아니다.

## 범위

- T4: bootstrap/runtime 분리, VPC·서브넷6·IGW·Public NAT1+EIP·라우트·SG6·Endpoint·SSM IAM 기반·상태 backend.
- T5~T9의 EC2·DB·AMI 제작·user_data·ALB 본체/리스너·ACM·Route53 리소스·대시보드는 만들지 않는다.
- src/·sender/·scripts/·test/·package 파일·API 계약·불변 규칙 수정 금지. T3 보고와 ignored 실행 증거 보존.

## 실행과 네트워크

- apply/destroy는 사람만 실행한다. CLI/SDK/provisioner/terraform test를 통한 우회 변경도 금지한다.
- 승인된 입력·도구·인증이 있을 때 fmt/check, 안전한 init, validate, plan/show와 읽기 전용 조회만 허용한다.
  import, state 변경, force-unlock, 자동 상태 이전·backend 교체 금지. 시크릿이 있는 plan/state 전체 출력 금지.
- 승인된 서비스 체인과 관리 통신만 허용한다. 공개 ingress(0.0.0.0/0·::/0), EC2 퍼블릭 IP, DB 인터넷 경로 금지.
  외부 ALB SG는 승인 CIDR 미입력 시 ingress가 비어 있어야 한다.
- 앱 SG의 외부 egress는 승인된 NAT 경유 TCP 443만 허용한다. 도메인 allowlist가 아니며 HTTP 80·전체 포트를 추가하지 않는다.
- DB 관리 HTTPS는 vpce-sg와 승인된 S3 prefix-list 경로만 사용한다. 임시 IGW/NAT 경로 금지.
- 시크릿 실제값을 Terraform 변수/data source/resource/user_data/output/state/로그에 유입시키지 않는다.
  이름·ARN·IAM만 다루며, 실제 조회는 후속 인스턴스 런타임에 둔다. 광범위 Allow에 좁은 Allow를 더해 제한했다고 보고하지 않는다.

## 수명주기와 증거

- 상태 bootstrap과 demo runtime을 분리한다. 상태·기존 DNS 자산·공유 자원은 runtime destroy에서 제외한다.
  48~72시간은 가동 계획이지 금액 상한이나 연속 이벤트 생성 승인이 아니다. 종료 후 잔존 비용을 따로 점검한다.
- 실제 tfvars/backend 로컬 설정/plan/state/.terraform은 infra/.gitignore로 제외하고,
  비밀값 없는 예시와 .terraform.lock.hcl은 관리한다. 실제 도구 없이 lockfile을 만들어내지 않는다.
- 설정 파싱, 역할 호출, 코드, validate, 실제 plan, 독립 리뷰, 사람 apply, AWS 실측은 각각 구분한다.
  PASS/FAIL/BLOCKED/NOT_RUN, 실행 시각·명령·종료 코드와 증거를 기록한다. 미실행 plan의 자원 수를 0으로 쓰지 않는다.
- Git add/commit/push, 브랜치 조작 및 기존 변경 복구·정리 명령을 자동 실행하지 않는다.
