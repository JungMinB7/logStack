import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { EventBatchRequestDto } from './dto/event-batch-request.dto';
import { IngestionService } from './ingestion.service';
import type { EventBatchResponse } from './ingestion.types';

/**
 * POST /api/v1/event-batches (docs/api.openapi.yaml — ingestEventBatch).
 * HTTP 변환만 담당한다 — 검증 정책·카운트 계산은 Service, DB는 Repository (ADR-002).
 * 배치 구조가 유효하면 전부 거절이어도 200 (AI_RULES 25) — POST 기본값 201을 200으로 고정.
 *
 * 가드 순서(선언 순서대로 실행): ApiKeyGuard(401/403) → RateLimitGuard(429).
 * 인증을 통과한 요청만 rate limit 카운터를 소모하며, 429로 거절된 요청은
 * 컨트롤러에 도달하지 않으므로 아무 이벤트도 저장되지 않는다.
 */
@Controller('api/v1/event-batches')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  ingest(@Body() dto: EventBatchRequestDto): Promise<EventBatchResponse> {
    return this.ingestionService.ingest(dto);
  }
}
