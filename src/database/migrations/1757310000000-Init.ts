import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 초기 스키마 — 구 prisma/migrations/20260728032846_init/migration.sql과
 * 결과가 완전히 동일하도록 같은 raw SQL을 그대로 실행한다 (ADR-005).
 *
 * - 테이블 2개: game_events, purchases
 * - 인덱스 4개: idx_events_type_time, idx_events_user_time,
 *   idx_purchases_time_currency, idx_purchases_user_time
 * - order_id UNIQUE, FK ON DELETE CASCADE ON UPDATE CASCADE
 * - CHECK 2건(quantity >= 1, amount_minor >= 0) — DB 제약이 최종 방어선 (design.md §7.2)
 */
export class Init1757310000000 implements MigrationInterface {
  name = 'Init1757310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "game_events" (
          "event_id" UUID NOT NULL,
          "instance_id" UUID NOT NULL,
          "event_type" VARCHAR(32) NOT NULL,
          "user_id" BIGINT NOT NULL,
          "character_id" BIGINT NOT NULL,
          "session_id" VARCHAR(64) NOT NULL,
          "channel_id" VARCHAR(64) NOT NULL,
          "payload" JSONB NOT NULL,
          "occurred_at" TIMESTAMPTZ(3) NOT NULL,
          "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "game_events_pkey" PRIMARY KEY ("event_id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "purchases" (
          "event_id" UUID NOT NULL,
          "order_id" VARCHAR(64) NOT NULL,
          "user_id" BIGINT NOT NULL,
          "occurred_at" TIMESTAMPTZ(3) NOT NULL,
          "product_id" VARCHAR(64) NOT NULL,
          "product_name" VARCHAR(128) NOT NULL,
          "quantity" INTEGER NOT NULL,
          "amount_minor" BIGINT NOT NULL,
          "currency" CHAR(3) NOT NULL,

          CONSTRAINT "purchases_pkey" PRIMARY KEY ("event_id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_events_type_time" ON "game_events"("event_type", "occurred_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_events_user_time" ON "game_events"("user_id", "occurred_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "purchases_order_id_key" ON "purchases"("order_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_purchases_time_currency" ON "purchases"("occurred_at", "currency")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_purchases_user_time" ON "purchases"("user_id", "occurred_at")`,
    );

    await queryRunner.query(
      `ALTER TABLE "purchases" ADD CONSTRAINT "purchases_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "game_events"("event_id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );

    // CHECK 제약 — 엔티티/스키마 파일이 표현하지 못해 raw SQL로 직접 기술 (구 방식 동일)
    await queryRunner.query(
      `ALTER TABLE "purchases" ADD CONSTRAINT "purchases_quantity_check" CHECK ("quantity" >= 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" ADD CONSTRAINT "purchases_amount_minor_check" CHECK ("amount_minor" >= 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "purchases"`);
    await queryRunner.query(`DROP TABLE "game_events"`);
  }
}
