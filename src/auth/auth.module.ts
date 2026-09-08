import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { ApiKeyGuard } from './api-key.guard';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitStore } from './rate-limit.store';

/**
 * 인증·요청 한도 모듈.
 * - 적재: ApiKeyGuard — 인스턴스별 API 키(Bearer) 검증 + 키-instance_id 일치 검증
 *   (design.md §5.4)
 * - 적재: RateLimitGuard — 키 단위 고정 1분 창 rate limit (429 + Retry-After,
 *   design-aws.md §5). 인증 뒤에 실행되어야 하므로 컨트롤러에서
 *   @UseGuards(ApiKeyGuard, RateLimitGuard) 순서로 선언한다
 * - 조회: AdminApiKeyGuard — ADMIN_API_KEY 검증 (design.md §10.1)
 */
@Module({
  providers: [ApiKeyGuard, AdminApiKeyGuard, RateLimitGuard, RateLimitStore],
  exports: [ApiKeyGuard, AdminApiKeyGuard, RateLimitGuard, RateLimitStore],
})
export class AuthModule {}
