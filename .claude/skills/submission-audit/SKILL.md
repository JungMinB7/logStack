---
name: submission-audit
description: 코딩 과제 최종 제출 전 감사를 수행한다. 최종 제출 커밋 전에 사용.
---

먼저 docs/spec.md를 읽고 제출 요구사항을 확인하라.

다음 항목을 순서대로 실제 실행하며 점검하라:

1. npm run build 성공
2. npm test 와 npm run test:e2e 전부 통과
3. 깨끗한 상태에서 docker compose up 으로 기동됨
   (기존 볼륨 삭제 후: docker compose down -v && docker compose up -d)
4. README의 모든 명령을 적힌 그대로 복사-실행해서 동작함
5. 중복 event_id 데모가 동작함 (같은 배치 2번 전송 → stored는 1번만)
6. 고정 테스트 데이터의 DAU, D1/D7/D30, 매출, ARPU, 전환율이
   test/fixtures의 예상값과 정확히 일치함
7. 잘못된 API 키 → 401 테스트 존재
8. start > end → 400 테스트 존재
9. docs/api.openapi.yaml 이 실제 컨트롤러와 일치함
10. docs/design.pdf 가 존재하고 docs/design.md 최신 내용과 일치함
11. .env 가 커밋되지 않았고 .env.example 만 있음
12. 가정(assumptions.md)과 한계·미구현 항목이 README에 반영됨

발견한 문제를 몰래 고치지 마라.
실행한 명령과 함께 통과/실패 표로 보고하라.