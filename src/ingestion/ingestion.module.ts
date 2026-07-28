import { Module } from '@nestjs/common';

/**
 * 적재 모듈 (스캐폴드 — 이후 작업에서 구현).
 * POST /api/v1/event-batches — Controller → Service → Repository 3층 구조 (design.md §11)
 * 트랜잭션 3단계는 design.md §6.2를 따른다.
 */
@Module({})
export class IngestionModule {}
