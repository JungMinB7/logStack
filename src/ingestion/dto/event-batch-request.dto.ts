import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsUUID,
} from 'class-validator';

/**
 * 배치 구조 DTO (docs/api.openapi.yaml — EventBatchRequest).
 *
 * 여기서는 "배치 구조"만 검증한다 (실패 시 400 MALFORMED_REQUEST).
 * events 원소는 의도적으로 unknown으로 둔다 — 개별 이벤트 검증 실패는
 * 400이 아니라 200 + rejected(per-event)여야 하기 때문이다 (AI_RULES 25).
 * 개별 이벤트 검증은 IngestionService가 수행한다 (design.md §8.1).
 */
export class EventBatchRequestDto {
  @IsUUID()
  batch_id!: string;

  @IsISO8601()
  sent_at!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  events!: unknown[];
}
