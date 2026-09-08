# CLAUDE.md

## 작업 전 반드시 읽을 파일 (순서대로)
1. AI_RULES.md          — 절대 어기면 안 되는 불변 규칙
2. docs/spec.md         — 과제 원문. 요구사항의 유일한 기준
3. docs/assumptions.md  — 확정된 가정 목록
4. docs/decisions.md    — 이미 내린 설계 결정. 임의로 뒤집지 말 것
5. docs/api.openapi.yaml — API 계약

## 아키텍처
Controller → Service → Repository 3층 구조.
- Controller: HTTP 요청/응답 변환만
- Service: 업무 규칙, 검증, 지표 정의
- Repository: ORM(TypeORM)·SQL 전담
Port/Adapter, Domain Entity 분리 같은 클린 아키텍처 패턴을 도입하지 않는다.
(docs/decisions.md의 ADR-002 참조 — 의도된 결정임)

## API 계약 변경 시 같은 커밋에서 함께 갱신할 것
- docs/api.openapi.yaml
- README.md의 호출 예시
- 관련 테스트
- docs/design.md의 해당 섹션

## 작업 방식
- 한 번에 한 기능만 구현한다 (예: 적재 API만, DAU API만)
- 코드 변경 후 AI_RULES.md의 필수 검증 명령을 실행한다
- README에 적는 모든 명령은 실제로 실행해서 검증한 것만 적는다
- 코드 작성 시 코드를 보는 사람들이 이해하기 쉽게 간결하고 핵심적인 주석을 달아야한다. (과한 주석은 자제)
- 모든 작업은 시작 전에 git branch --show-current로 현재 브랜치를 확인하고,
  main이 아니면 멈춰서 보고한다 (별도 지시가 있는 경우 제외)