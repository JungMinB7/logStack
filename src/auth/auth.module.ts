import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { ApiKeyGuard } from './api-key.guard';

/**
 * 인증 모듈.
 * - 적재: ApiKeyGuard — 인스턴스별 API 키(Bearer) 검증 + 키-instance_id 일치 검증
 *   (design.md §5.4)
 * - 조회: AdminApiKeyGuard — ADMIN_API_KEY 검증 (design.md §10.1)
 */
@Module({
  providers: [ApiKeyGuard, AdminApiKeyGuard],
  exports: [ApiKeyGuard, AdminApiKeyGuard],
})
export class AuthModule {}
