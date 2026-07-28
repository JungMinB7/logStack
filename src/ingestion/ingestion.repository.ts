import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { NormalizedEvent } from './ingestion.types';

export interface StoreBatchResult {
  /** ①에서 실제로 새로 삽입된 event_id 집합 */
  storedEventIds: Set<string>;
  /** ②에서 실제로 삽입된 결제 파생 행의 event_id 집합 */
  purchaseStoredEventIds: Set<string>;
  /** ②의 삽입 시도 대상(이번에 새로 저장된 shop_purchase) 수 */
  purchaseCandidateCount: number;
}

/**
 * 적재 트랜잭션 (design.md §6.2 — 3단계 순서를 정확히 따른다).
 *
 * ① 원본 INSERT ... ON CONFLICT (event_id) DO NOTHING + RETURNING
 *    — Prisma createMany(skipDuplicates)는 "삽입된 행 집합"을 돌려주지 않으므로
 *      $queryRaw를 사용한다. RETURNING이 멱등성 카운트(stored/duplicate)의 근거다.
 * ② ①에서 삽입된 집합의 shop_purchase만 purchases에
 *    INSERT ... ON CONFLICT (order_id) DO NOTHING + RETURNING
 *    — 결제 파생은 "이번 트랜잭션에서 새로 저장된 원본"에만 생성 (AI_RULES 19)
 * ③ ②에서 생략된 건수 = order_duplicate_count (Service가 계산)
 *
 * 문장 단위 conflict 처리이므로 충돌이 나도 같은 배치의 다른 이벤트는
 * 롤백되지 않는다 (design.md §6.2).
 */
@Injectable()
export class IngestionRepository {
  /**
   * 트랜잭션 timeout 8초 — 서버 내부 하드 데드라인 10초(design.md §6.4) 이내에서
   * 500건 최대 배치에 여유를 준다. 개별 문장은 statement_timeout 5초(PrismaService)로
   * 별도 차단된다.
   */
  private static readonly TRANSACTION_TIMEOUT_MS = 8_000;

  constructor(private readonly prisma: PrismaService) {}

  async storeBatch(events: NormalizedEvent[]): Promise<StoreBatchResult> {
    return this.prisma.$transaction(
      async (tx) => {
        // ① 원본 이벤트 삽입
        const eventRows = events.map(
          (e) =>
            Prisma.sql`(${e.eventId}::uuid, ${e.instanceId}::uuid, ${e.eventType}, ${e.userId}, ${e.characterId}, ${e.sessionId}, ${e.channelId}, ${JSON.stringify(e.payload)}::jsonb, ${e.occurredAt}::timestamptz)`,
        );
        const inserted = await tx.$queryRaw<Array<{ event_id: string }>>(
          Prisma.sql`
            INSERT INTO game_events
              (event_id, instance_id, event_type, user_id, character_id,
               session_id, channel_id, payload, occurred_at)
            VALUES ${Prisma.join(eventRows)}
            ON CONFLICT (event_id) DO NOTHING
            RETURNING event_id
          `,
        );
        const storedEventIds = new Set(inserted.map((row) => row.event_id));

        // ② 이번에 새로 저장된 원본 중 shop_purchase만 파생 삽입
        const candidates = events.filter(
          (e) => e.purchase !== undefined && storedEventIds.has(e.eventId),
        );
        let purchaseStoredEventIds = new Set<string>();
        if (candidates.length > 0) {
          const purchaseRows = candidates.map((e) => {
            const p = e.purchase!;
            return Prisma.sql`(${e.eventId}::uuid, ${p.orderId}, ${e.userId}, ${e.occurredAt}::timestamptz, ${p.productId}, ${p.productName}, ${p.quantity}, ${p.amountMinor}, ${p.currency})`;
          });
          const insertedPurchases = await tx.$queryRaw<
            Array<{ event_id: string }>
          >(Prisma.sql`
            INSERT INTO purchases
              (event_id, order_id, user_id, occurred_at,
               product_id, product_name, quantity, amount_minor, currency)
            VALUES ${Prisma.join(purchaseRows)}
            ON CONFLICT (order_id) DO NOTHING
            RETURNING event_id
          `);
          purchaseStoredEventIds = new Set(
            insertedPurchases.map((row) => row.event_id),
          );
        }

        return {
          storedEventIds,
          purchaseStoredEventIds,
          purchaseCandidateCount: candidates.length,
        };
      },
      { timeout: IngestionRepository.TRANSACTION_TIMEOUT_MS },
    );
  }
}
