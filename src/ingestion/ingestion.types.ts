import type { EventType } from './dto/event-envelope.dto';

/** 검증을 통과해 저장 대상으로 정규화된 이벤트 */
export interface NormalizedEvent {
  eventId: string;
  instanceId: string;
  eventType: EventType;
  userId: number;
  characterId: number;
  sessionId: string;
  channelId: string;
  /** 원본 그대로 보존해 JSONB로 저장 (design.md §8.1) */
  payload: Record<string, unknown>;
  /** ISO8601 문자열 (DB에서 ::timestamptz 캐스팅) */
  occurredAt: string;
  /** shop_purchase일 때만 존재 — purchases 파생 행 재료 */
  purchase?: {
    orderId: string;
    productId: string;
    productName: string;
    quantity: number;
    amountMinor: number;
    currency: string;
  };
}

/** per-event 거절 항목 (docs/api.openapi.yaml — EventBatchResponse.rejected) */
export interface RejectedEvent {
  index: number;
  event_id?: string;
  code: string;
  message: string;
}

/**
 * 적재 응답 (docs/api.openapi.yaml — EventBatchResponse).
 * 불변식: received = accepted + rejected / accepted = stored + duplicate /
 * order_duplicate ⊆ stored (AI_RULES 18)
 */
export interface EventBatchResponse {
  batch_id: string;
  received_count: number;
  accepted_count: number;
  stored_count: number;
  duplicate_count: number;
  order_duplicate_count: number;
  rejected_count: number;
  rejected: RejectedEvent[];
}
