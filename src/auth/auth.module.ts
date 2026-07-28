import { Module } from '@nestjs/common';

/**
 * 인증 모듈 (스캐폴드 — 이후 작업에서 구현).
 * - 적재: 인스턴스별 API 키(Bearer) 검증 + 키-instance_id 일치 검증 (design.md §5.4)
 * - 조회: ADMIN_API_KEY 검증
 */
@Module({})
export class AuthModule {}
