import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetricsController } from './metrics.controller';
import { MetricsRepository } from './metrics.repository';
import { MetricsService } from './metrics.service';

/**
 * 지표 조회 모듈 — GET /api/v1/metrics/{dau,retention} 구현됨.
 * revenue, purchase-conversion, engagement는 이후 작업에서 추가.
 * 지표 정의는 design.md §9, 응답 계약은 §10 및 docs/api.openapi.yaml을 따른다.
 */
@Module({
  imports: [AuthModule],
  controllers: [MetricsController],
  providers: [MetricsService, MetricsRepository],
})
export class MetricsModule {}
