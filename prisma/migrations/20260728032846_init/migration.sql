-- CreateTable
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
);

-- CreateTable
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
);

-- CreateIndex
CREATE INDEX "idx_events_type_time" ON "game_events"("event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_events_user_time" ON "game_events"("user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_order_id_key" ON "purchases"("order_id");

-- CreateIndex
CREATE INDEX "idx_purchases_time_currency" ON "purchases"("occurred_at", "currency");

-- CreateIndex
CREATE INDEX "idx_purchases_user_time" ON "purchases"("user_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "game_events"("event_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 수동 추가: CHECK 제약 (design.md §7.2 — DB 제약이 최종 방어선)
-- Prisma 스키마 파일은 CHECK를 표현할 수 없어 마이그레이션 SQL에 직접 기술한다.
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_quantity_check" CHECK ("quantity" >= 1);
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_amount_minor_check" CHECK ("amount_minor" >= 0);
