import { Column, Entity, Index, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { GameEvent } from './game-event.entity';

/**
 * purchases — 결제 파생 테이블 (design.md §7.2).
 * 구 prisma/schema.prisma의 Purchase 모델과 컬럼·타입·제약·인덱스가 완전히 동일하다.
 *
 * 설계 포인트:
 * - orderId UNIQUE: event_id(전송 멱등성 키)와 별개의 "업무 키".
 *   같은 주문이 다른 event_id로 재전송돼도 매출 중복을 이중 방어 (design.md §6.2).
 * - amountMinor BIGINT: 최소 화폐 단위 정수. 부동소수점 저장 금지 (AI_RULES 4).
 *   합계는 raw SQL에서 ::text로 반환해 BIGINT 오버플로우·직렬화 문제를 차단.
 * - currency CHAR(3): ISO 4217. 통화 간 합산 금지는 쿼리 계층에서 보장 (AI_RULES 5).
 * - CHECK(quantity >= 1, amount_minor >= 0)는 엔티티가 표현하지 못해
 *   마이그레이션 raw SQL에 직접 기술한다 (구 Prisma 시절과 동일한 방식).
 */
@Entity('purchases')
@Index('idx_purchases_time_currency', ['occurredAt', 'currency'])
@Index('idx_purchases_user_time', ['userId', 'occurredAt'])
export class Purchase {
  @PrimaryColumn('uuid', { name: 'event_id' })
  eventId!: string;

  @Column('varchar', { name: 'order_id', length: 64, unique: true })
  orderId!: string;

  @Column('bigint', { name: 'user_id' })
  userId!: string;

  @Column('timestamp with time zone', { name: 'occurred_at', precision: 3 })
  occurredAt!: Date;

  @Column('varchar', { name: 'product_id', length: 64 })
  productId!: string;

  @Column('varchar', { name: 'product_name', length: 128 })
  productName!: string;

  @Column('integer')
  quantity!: number;

  @Column('bigint', { name: 'amount_minor' })
  amountMinor!: string;

  @Column('char', { length: 3 })
  currency!: string;

  /** 원본 이벤트와 연결 — 원본 삭제 시 파생도 함께 삭제 (ON DELETE CASCADE) */
  @OneToOne(() => GameEvent, (event) => event.purchase, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'event_id' })
  event!: GameEvent;
}
