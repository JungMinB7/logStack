import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard';
import { MetricsQueryDto } from './dto/metrics-query.dto';
import { MetricsService } from './metrics.service';
import type { DauResponse, RetentionResponse } from './metrics.types';

/**
 * 지표 조회 API (docs/api.openapi.yaml — metrics).
 * HTTP 변환만 담당 — 기간 검증·지표 정의는 Service, SQL은 Repository (ADR-002).
 */
@Controller('api/v1/metrics')
@UseGuards(AdminApiKeyGuard)
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('dau')
  getDau(@Query() query: MetricsQueryDto): Promise<DauResponse> {
    return this.metricsService.getDau(query);
  }

  @Get('retention')
  getRetention(@Query() query: MetricsQueryDto): Promise<RetentionResponse> {
    return this.metricsService.getRetention(query);
  }
}
