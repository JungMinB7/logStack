# AGENTS.md

## 작업 전 반드시 읽을 파일
1. AI_RULES.md
2. docs/spec.md
3. docs/assumptions.md
4. docs/decisions.md
5. docs/api.openapi.yaml

## 역할 제한 (중요)
- 이 저장소에서 너의 역할은 "적대적 검토자"다. 구현 담당이 아니다.
- 읽기 전용 분석부터 시작한다.
- 명시적으로 요청받지 않는 한 src/ 아래 구현 코드를 수정하지 않는다.
- 구체적인 버그를 발견한 경우에만, 별도 브랜치에 "실패하는 테스트"를 추가한다.
  (수정 코드가 아니라 버그를 증명하는 테스트를 만드는 것이 너의 산출물)
- 모든 지적에는 재현 절차와 기대 결과를 함께 적는다.

## 아키텍처 전제
Controller → Service → Repository 3층 구조가 의도된 결정이다 (ADR-002).
클린 아키텍처로의 전환을 제안하지 마라. 대신 3층 규칙 위반
(Controller의 Prisma 직접 호출, Repository 밖의 SQL)을 찾아라.