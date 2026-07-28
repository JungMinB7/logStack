import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/**
 * 지표 조회 공통 쿼리 파라미터 (design.md §10.1, docs/api.openapi.yaml).
 * 형식 검증만 여기서 하고, 의미 검증(기간 역전 INVALID_DATE_RANGE,
 * 366일 초과 RANGE_TOO_LARGE)은 MetricsService가 수행한다.
 */
export class MetricsQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'start must be formatted as YYYY-MM-DD',
  })
  start!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'end must be formatted as YYYY-MM-DD',
  })
  end!: string;

  /** 범위 밖 page는 200 + 빈 data (400 아님) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number;
}
