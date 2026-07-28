import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { isUUID, validateSync } from 'class-validator';
import {
  firstConstraintMessage,
  MAX_ERROR_MESSAGE_LENGTH,
} from '../common/validation.util';
import type { EventBatchRequestDto } from './dto/event-batch-request.dto';
import {
  EventEnvelopeDto,
  ShopPurchasePayloadDto,
} from './dto/event-envelope.dto';
import { IngestionRepository, StoreBatchResult } from './ingestion.repository';
import type {
  EventBatchResponse,
  NormalizedEvent,
  RejectedEvent,
} from './ingestion.types';

type EventValidationResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; eventId?: string; code: string; message: string };

/**
 * 적재 업무 규칙 (design.md §5.3, §6.2, §8.1).
 * - per-event 검증: envelope 전체 + shop_purchase payload만 엄격 검증
 * - 검증 실패는 rejected로 수집 — 배치 구조가 유효하면 전부 거절이어도 200 (AI_RULES 25)
 * - 카운트 불변식: received = accepted + rejected / accepted = stored + duplicate /
 *   order_duplicate ⊆ stored (AI_RULES 18)
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(private readonly repository: IngestionRepository) {}

  async ingest(dto: EventBatchRequestDto): Promise<EventBatchResponse> {
    const startedAt = Date.now();
    const rejected: RejectedEvent[] = [];
    const accepted: NormalizedEvent[] = [];

    dto.events.forEach((raw, index) => {
      const result = this.validateEvent(raw);
      if (result.ok) {
        accepted.push(result.event);
      } else {
        rejected.push({
          index,
          ...(result.eventId !== undefined ? { event_id: result.eventId } : {}),
          code: result.code,
          message: result.message,
        });
      }
    });

    // 배치 내 동일 event_id 중복 제거 — 첫 등장만 INSERT 대상 (first-write-wins).
    // 이후 등장은 DB에 보내지 않아도 정의상 duplicate다 (아래 duplicate 계산에 포함됨).
    const seen = new Set<string>();
    const unique: NormalizedEvent[] = [];
    for (const event of accepted) {
      if (!seen.has(event.eventId)) {
        seen.add(event.eventId);
        unique.push(event);
      }
    }

    let storedCount = 0;
    let orderDuplicateCount = 0;
    if (unique.length > 0) {
      let result: StoreBatchResult;
      try {
        result = await this.repository.storeBatch(unique);
      } catch (error) {
        // DB 장애·statement_timeout 등 — 롤백 후 503, 전송측 재시도 대상 (design.md §6.4)
        this.logger.error(
          'batch store failed',
          error instanceof Error ? error.stack : String(error),
        );
        throw new ServiceUnavailableException({
          error: {
            code: 'STORAGE_UNAVAILABLE',
            message: 'temporary storage failure, retry later',
          },
        });
      }
      storedCount = result.storedEventIds.size;
      orderDuplicateCount =
        result.purchaseCandidateCount - result.purchaseStoredEventIds.size;
    }

    // 불변식: accepted = stored + duplicate (duplicate = PK 충돌 + 배치 내 중복)
    const response: EventBatchResponse = {
      batch_id: dto.batch_id,
      received_count: dto.events.length,
      accepted_count: accepted.length,
      stored_count: storedCount,
      duplicate_count: accepted.length - storedCount,
      order_duplicate_count: orderDuplicateCount,
      rejected_count: rejected.length,
      rejected,
    };

    // 관측용 구조화 로그 — 배치 처리 시간과 카운터 (design.md §6.5)
    this.logger.log(
      JSON.stringify({
        msg: 'batch processed',
        batch_id: response.batch_id,
        received: response.received_count,
        stored: response.stored_count,
        duplicate: response.duplicate_count,
        order_duplicate: response.order_duplicate_count,
        rejected: response.rejected_count,
        duration_ms: Date.now() - startedAt,
      }),
    );

    return response;
  }

  /**
   * 이벤트 단위 검증 (payload는 unknown으로 받는다 — AI_RULES 16).
   * message는 서버 정의 문구(≤200자)이며 사용자 입력을 반사하지 않는다 (AI_RULES 27).
   */
  private validateEvent(raw: unknown): EventValidationResult {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return {
        ok: false,
        code: 'INVALID_ENVELOPE',
        message: 'event must be a JSON object',
      };
    }

    // 거절 응답에 실을 event_id — 유효한 UUID일 때만 포함 (입력 반사 방지)
    const rawEventId = (raw as { event_id?: unknown }).event_id;
    const eventId =
      typeof rawEventId === 'string' && isUUID(rawEventId)
        ? rawEventId
        : undefined;

    const envelope = plainToInstance(EventEnvelopeDto, raw);
    const envelopeErrors = validateSync(envelope, {
      forbidUnknownValues: false,
    });
    if (envelopeErrors.length > 0) {
      return {
        ok: false,
        eventId,
        code: 'INVALID_ENVELOPE',
        message: firstConstraintMessage(envelopeErrors),
      };
    }

    const event: NormalizedEvent = {
      // UUID 정규화(소문자) — PostgreSQL RETURNING은 정규형(소문자)을 반환하므로
      // 대문자 입력 시 repository의 storedEventIds 비교가 어긋나 결제 파생이
      // 유실되는 버그 방지. 배치 내 dedupe Set·guard 비교도 이 정규형 기준.
      eventId: envelope.event_id.toLowerCase(),
      instanceId: envelope.instance_id.toLowerCase(),
      eventType: envelope.event_type,
      userId: envelope.user_id,
      characterId: envelope.character_id,
      sessionId: envelope.session_id,
      channelId: envelope.channel_id,
      payload: envelope.payload,
      occurredAt: envelope.occurred_at,
    };

    if (envelope.event_type === 'shop_purchase') {
      const payloadDto = plainToInstance(ShopPurchasePayloadDto, envelope.payload);
      const payloadErrors = validateSync(payloadDto, {
        forbidUnknownValues: false,
      });
      if (payloadErrors.length > 0) {
        return {
          ok: false,
          eventId,
          code: 'INVALID_PAYLOAD',
          message: `shop_purchase.payload: ${firstConstraintMessage(payloadErrors)}`.slice(
            0,
            MAX_ERROR_MESSAGE_LENGTH,
          ),
        };
      }
      event.purchase = {
        orderId: payloadDto.order_id,
        productId: payloadDto.product_id,
        productName: payloadDto.product_name,
        quantity: payloadDto.quantity,
        amountMinor: payloadDto.amount_minor,
        currency: payloadDto.currency,
      };
    }

    return { ok: true, event };
  }
}
