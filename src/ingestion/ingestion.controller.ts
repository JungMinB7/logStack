import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { EventBatchRequestDto } from './dto/event-batch-request.dto';
import { IngestionService } from './ingestion.service';
import type { EventBatchResponse } from './ingestion.types';

/**
 * POST /api/v1/event-batches (docs/api.openapi.yaml — ingestEventBatch).
 * HTTP 변환만 담당한다 — 검증 정책·카운트 계산은 Service, DB는 Repository (ADR-002).
 * 배치 구조가 유효하면 전부 거절이어도 200 (AI_RULES 25) — POST 기본값 201을 200으로 고정.
 */
@Controller('api/v1/event-batches')
@UseGuards(ApiKeyGuard)
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  ingest(@Body() dto: EventBatchRequestDto): Promise<EventBatchResponse> {
    return this.ingestionService.ingest(dto);
  }
}
