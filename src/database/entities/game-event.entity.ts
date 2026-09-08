import { Column, Entity, Index, OneToOne, PrimaryColumn } from 'typeorm';
import { Purchase } from './purchase.entity';

/**
 * game_events — 모든 원본 이벤트 (design.md §7.1).
 * 구 prisma/schema.prisma의 GameEvent 모델과 컬럼·타입·인덱스가 완전히 동일하다.
 *
 * 설계 포인트:
 * - eventId가 PK = 멱등성 키. INSERT ... ON CONFLICT (event_id) DO NOTHING의 근거.
 * - eventType을 PG enum이 아니라 VARCHAR로 둔 이유: 새 이벤트 타입 추가 시
 *   DB 마이그레이션 없이 수용하기 위해 (design.md §8.1). 허용 목록 검증은 DTO 계층.
 * - userId/characterId는 BIGINT — TypeORM(pg)은 bigint를 문자열로 반환하므로
 *   집계는 raw SQL에서 ::int/::text 캐스팅으로 반환 타입을 통제한다 (AI_RULES 15).
 * - occurredAt/receivedAt 분리: 지표는 occurredAt 기준 (AI_RULES 2).
 * - timestamptz(3): 명세가 ms 정밀도 ISO8601이므로 밀리초까지 보존.
 *
 * ⚠ synchronize: false — 스키마의 원천은 src/database/migrations/의 raw SQL이다.
 */
@Entity('game_events')
@Index('idx_events_type_time', ['eventType', 'occurredAt'])
@Index('idx_events_user_time', ['userId', 'occurredAt'])
export class GameEvent {
  @PrimaryColumn('uuid', { name: 'event_id' })
  eventId!: string;

  @Column('uuid', { name: 'instance_id' })
  instanceId!: string;

  @Column('varchar', { name: 'event_type', length: 32 })
  eventType!: string;

  @Column('bigint', { name: 'user_id' })
  userId!: string;

  @Column('bigint', { name: 'character_id' })
  characterId!: string;

  @Column('varchar', { name: 'session_id', length: 64 })
  sessionId!: string;

  @Column('varchar', { name: 'channel_id', length: 64 })
  channelId!: string;

  /** JSONB — 타입별 상세를 원본 그대로 보존 */
  @Column('jsonb')
  payload!: Record<string, unknown>;

  @Column('timestamp with time zone', { name: 'occurred_at', precision: 3 })
  occurredAt!: Date;

  @Column('timestamp with time zone', {
    name: 'received_at',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP',
  })
  receivedAt!: Date;

  /** shop_purchase인 경우에만 파생 행이 존재 (1:0..1) */
  @OneToOne(() => Purchase, (purchase) => purchase.event)
  purchase?: Purchase;
}
