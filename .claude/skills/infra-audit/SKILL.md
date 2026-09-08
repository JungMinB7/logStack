---
name: infra-audit
description: 배포 전·데모 전 최종 인프라 감사. terraform plan 검사와 보안·비용·재현성 체크리스트를 실행한다.
---
1. terraform fmt -check, validate 실행
2. plan 출력에서: 삭제 예정 리소스 유무, 퍼블릭 IP 부여, 0.0.0.0/0, 미태깅 확인
3. 시크릿 스캔: *.tf, user_data에서 키·비밀번호 패턴 검색
4. 문서 대조: design-aws.md의 아키텍처·SG 체인과 코드 일치 여부
5. 비용 추정표와 destroy 계획이 README-aws에 있는지
발견 문제를 고치지 말고 통과/실패 표로 보고하라.
