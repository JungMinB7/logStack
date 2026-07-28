import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * 공통 관심사 모듈 — health check, (이후 작업) 공통 에러 필터·페이지네이션 유틸 등.
 */
@Module({
  controllers: [HealthController],
})
export class CommonModule {}
