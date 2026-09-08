import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  STATEMENT_TIMEOUT_MS,
  TRANSACTION_TIMEOUT_MS,
} from '../database/data-source';
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
 *    — RETURNING이 멱등성 카운트(stored/duplicate)의 근거다. SQL은 Prisma 시절의
 *      문자열을 $n 파라미터 그대로 이식했다 (ADR-005 — QueryBuilder 재작성 금지).
 * ② ①에서 삽입된 집합의 shop_purchase만 purchases에
 *    INSERT ... ON CONFLICT (order_id) DO NOTHING + RETURNING
 *    — 결제 파생은 "이번 트랜잭션에서 새로 저장된 원본"에만 생성 (AI_RULES 19)
 * ③ ②에서 생략된 건수 = order_duplicate_count (Service가 계산)
 *
 * 문장 단위 conflict 처리이므로 충돌이 나도 같은 배치의 다른 이벤트는
 * 롤백되지 않는다 (design.md §6.2).
 *
 * 트랜잭션 전체 상한 8초(design.md §6.4): 각 문장 직전에 남은 예산으로
 * SET LOCAL statement_timeout을 갱신한다 (문장별 상한은 5초 유지).
 * 초과 시 PG가 57014(query_canceled)로 롤백을 보장하고, Service가 503으로 변환한다.
 */
@Injectable()
export class IngestionRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async storeBatch(events: NormalizedEvent[]): Promise<StoreBatchResult> {
    return this.dataSource.transaction(async (manager) => {
      const deadline = Date.now() + TRANSACTION_TIMEOUT_MS;

      // ① 원본 이벤트 삽입
      const eventParams: unknown[] = [];
      const eventRows = events.map((e) => {
        const base = eventParams.length;
        eventParams.push(
          e.eventId,
          e.instanceId,
          e.eventType,
          e.userId,
          e.characterId,
          e.sessionId,
          e.channelId,
          JSON.stringify(e.payload),
          e.occurredAt,
        );
        return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9}::timestamptz)`;
      });
      const inserted = await this.run<Array<{ event_id: string }>>(
        manager,
        deadline,
        `
          INSERT INTO game_events
            (event_id, instance_id, event_type, user_id, character_id,
             session_id, channel_id, payload, occurred_at)
          VALUES ${eventRows.join(', ')}
          ON CONFLICT (event_id) DO NOTHING
          RETURNING event_id
        `,
        eventParams,
      );
      const storedEventIds = new Set(inserted.map((row) => row.event_id));

      // ② 이번에 새로 저장된 원본 중 shop_purchase만 파생 삽입
      const candidates = events.filter(
        (e) => e.purchase !== undefined && storedEventIds.has(e.eventId),
      );
      let purchaseStoredEventIds = new Set<string>();
      if (candidates.length > 0) {
        const purchaseParams: unknown[] = [];
        const purchaseRows = candidates.map((e) => {
          const p = e.purchase!;
          const base = purchaseParams.length;
          purchaseParams.push(
            e.eventId,
            p.orderId,
            e.userId,
            e.occurredAt,
            p.productId,
            p.productName,
            p.quantity,
            p.amountMinor,
            p.currency,
          );
          return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}::timestamptz, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
        });
        const insertedPurchases = await this.run<Array<{ event_id: string }>>(
          manager,
          deadline,
          `
            INSERT INTO purchases
              (event_id, order_id, user_id, occurred_at,
               product_id, product_name, quantity, amount_minor, currency)
            VALUES ${purchaseRows.join(', ')}
            ON CONFLICT (order_id) DO NOTHING
            RETURNING event_id
          `,
          purchaseParams,
        );
        purchaseStoredEventIds = new Set(
          insertedPurchases.map((row) => row.event_id),
        );
      }

      return {
        storedEventIds,
        purchaseStoredEventIds,
        purchaseCandidateCount: candidates.length,
      };
    });
  }

  /** 남은 트랜잭션 예산(≤5초)으로 statement_timeout을 갱신한 뒤 문장을 실행 */
  private async run<T>(
    manager: EntityManager,
    deadline: number,
    sql: string,
    params: unknown[],
  ): Promise<T> {
    const budget = Math.max(
      1,
      Math.min(deadline - Date.now(), STATEMENT_TIMEOUT_MS),
    );
    await manager.query(`SET LOCAL statement_timeout = '${budget}ms'`);
    return manager.query<T>(sql, params);
  }
}
