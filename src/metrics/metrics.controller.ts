import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard';
import { MetricsQueryDto } from './dto/metrics-query.dto';
import { RevenueQueryDto } from './dto/revenue-query.dto';
import { MetricsService } from './metrics.service';
import type {
  ConversionResponse,
  DauResponse,
  RetentionResponse,
  RevenueResponse,
} from './metrics.types';

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

  @Get('revenue')
  getRevenue(@Query() query: RevenueQueryDto): Promise<RevenueResponse> {
    return this.metricsService.getRevenue(query);
  }

  @Get('purchase-conversion')
  getPurchaseConversion(
    @Query() query: MetricsQueryDto,
  ): Promise<ConversionResponse> {
    return this.metricsService.getPurchaseConversion(query);
  }
}
