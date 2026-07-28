import { IsOptional, IsString } from 'class-validator';
import { MetricsQueryDto } from './metrics-query.dto';

/**
 * 참여율 조회 쿼리 (design.md §10.6) — event_type 생략 시 13개 타입 전체.
 * 목록 밖 값을 400 UNKNOWN_EVENT_TYPE으로 구분해 응답하기 위해 DTO에서는
 * 문자열로만 받고, 허용 목록 검증은 MetricsService가 수행한다.
 */
export class EngagementQueryDto extends MetricsQueryDto {
  @IsOptional()
  @IsString()
  event_type?: string;
}
