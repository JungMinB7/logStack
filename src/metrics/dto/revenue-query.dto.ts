import { IsOptional, IsString } from 'class-validator';
import { MetricsQueryDto } from './metrics-query.dto';

/**
 * 매출 조회 쿼리 (design.md §10.4) — currency 필수(통화 간 합산 방지, AI_RULES 5).
 * 형식 오류를 400 INVALID_CURRENCY로 구분해 응답하기 위해 DTO에서는 문자열로만
 * 받고, 필수·형식 검증은 MetricsService.parseCurrency가 수행한다.
 */
export class RevenueQueryDto extends MetricsQueryDto {
  @IsOptional()
  @IsString()
  currency?: string;
}
