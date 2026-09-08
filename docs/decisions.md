# 설계 결정 기록 (ADR)

## ADR-001: PostgreSQL 직접 배치 적재 (메시지 브로커 미도입)

### 결정
적재 API가 PostgreSQL에 직접 배치 INSERT 한다. Kafka 등 브로커는 도입하지 않는다.

### 근거
- 전송 제약 기준 요청 상한: 인스턴스 10개 × 120회/분 = 최대 20 req/s
- 이 규모에서 PostgreSQL 배치 입력은 충분하며, 브로커는 운영 복잡도만 추가
- event_id PK 유니크 제약으로 멱등성을 DB 수준에서 보장 가능
- 평가자가 docker compose 하나로 실행 가능해야 함

### 트레이드오프
- 트래픽이 수십 배 증가하면 DB가 병목이 될 수 있음
- 확장 경로: 적재 API와 저장 사이에 관리형 큐(Kafka/SQS) 삽입, API는 수신 즉시 ACK

## ADR-002: Controller → Service → Repository 3층 구조 (클린 아키텍처 미적용)

### 결정
기능별 모듈(ingestion, metrics) 안에서 3층 구조를 사용한다.
Port/Adapter 추상화, Domain Entity와 Prisma Model 분리는 하지 않는다.

### 근거
- 3일 과제 규모에서 Port/Adapter 추상화는 파일 수와 간접 참조만 늘리고
  실질적 이득(저장소 교체, 프레임워크 독립성)을 회수할 시점이 없음
- 평가 기준에 "코드가 간결하고 가독성이 좋은가"가 명시됨
- 핵심 이득은 유지: DB 접근을 Repository로 격리했으므로
  저장소 교체 지점은 확보됨. 규모가 커지면 Repository 인터페이스를
  추출하는 것만으로 Port/Adapter 구조로 점진 전환 가능

### 트레이드오프
- --Service가 Prisma 타입에 간접적으로 노출될 수 있음--(x -> TypeORM으로 교체)
- Service 단위 테스트 시 Repository를 jest.mock으로 대체 (인터페이스가 없어도 가능)