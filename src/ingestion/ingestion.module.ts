import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IngestionController } from './ingestion.controller';
import { IngestionRepository } from './ingestion.repository';
import { IngestionService } from './ingestion.service';

/**
 * 적재 모듈 — POST /api/v1/event-batches.
 * Controller → Service → Repository 3층 구조 (design.md §11, ADR-002).
 * 트랜잭션 3단계는 design.md §6.2 (IngestionRepository 참조).
 */
@Module({
  imports: [AuthModule],
  controllers: [IngestionController],
  providers: [IngestionService, IngestionRepository],
})
export class IngestionModule {}
