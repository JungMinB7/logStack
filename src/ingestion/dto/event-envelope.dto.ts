import {
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';

/** 명세의 13개 이벤트 타입 (docs/api.openapi.yaml — EventType) */
export const EVENT_TYPES = [
  'session_login',
  'session_logout',
  'level_up',
  'exp_gain',
  'monster_kill',
  'quest_complete',
  'item_acquire',
  'item_use',
  'currency_change',
  'shop_purchase',
  'boss_clear',
  'map_enter',
  'death',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * 공통 envelope 검증 (docs/api.openapi.yaml — EventEnvelope).
 * IngestionService가 이벤트 단위로 프로그래매틱하게 검증한다
 * (ValidationPipe 대상이 아님 — 실패는 400이 아니라 per-event rejected).
 * payload는 object 여부만 확인하고 원본을 보존한다 (design.md §8.1).
 */
export class EventEnvelopeDto {
  @IsUUID()
  instance_id!: string;

  @IsUUID()
  event_id!: string;

  @IsIn(EVENT_TYPES)
  event_type!: EventType;

  @IsInt()
  user_id!: number;

  @IsInt()
  character_id!: number;

  @IsString()
  @Length(1, 64)
  session_id!: string;

  @IsString()
  @Length(1, 64)
  channel_id!: string;

  @IsObject()
  payload!: Record<string, unknown>;

  // 계약: ISO8601 UTC(ms). IsISO8601만으로는 시간대 표기 없는 문자열
  // ("2026-01-01T10:00:00")이 통과해 DB 세션 시간대에 따라 해석이 달라지므로,
  // 시간대 지정자(Z 또는 ±hh:mm/±hhmm)를 필수로 강제한다.
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:?\d{2})$/, {
    message:
      'occurred_at must include an explicit timezone designator (Z or +hh:mm)',
  })
  occurred_at!: string;
}

/**
 * shop_purchase payload — 지표(매출) 산출에 필수인 유일한 payload이므로
 * 필드 단위 엄격 검증 (design.md §8.1·§8.2).
 */
export class ShopPurchasePayloadDto {
  @IsString()
  @Length(1, 64)
  order_id!: string;

  @IsString()
  @Length(1, 64)
  product_id!: string;

  @IsString()
  @Length(1, 128)
  product_name!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsInt()
  @Min(0)
  amount_minor!: number;

  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;
}
