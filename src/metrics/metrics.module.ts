import { Module } from '@nestjs/common';

/**
 * 지표 조회 모듈 (스캐폴드 — 이후 작업에서 구현).
 * GET /api/v1/metrics/{dau,retention,revenue,purchase-conversion,engagement}
 * 지표 정의는 design.md §9, 응답 계약은 §10 및 docs/api.openapi.yaml을 따른다.
 */
@Module({})
export class MetricsModule {}
