import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

/**
 * 인증 모듈.
 * - 적재: ApiKeyGuard — 인스턴스별 API 키(Bearer) 검증 + 키-instance_id 일치 검증
 *   (design.md §5.4)
 * - 조회(ADMIN_API_KEY) 가드는 지표 API 작업에서 추가한다.
 */
@Module({
  providers: [ApiKeyGuard],
  exports: [ApiKeyGuard],
})
export class AuthModule {}
