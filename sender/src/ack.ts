import {
  parseBatchResponse,
  type BatchResponse,
  type EventInput,
} from '../../scripts/send-events';

/**
 * design.md §4.2 "응답별 outbox 상태 전이" 표를 순수 함수로 옮긴 것.
 * 부수 효과(체크포인트 전진·격리·대기)는 daemon이 이 판정 결과로 수행한다.
 */
export type AckAction =
  /** 200 + 파싱·batch_id·불변식 통과 → 확인분 체크포인트 전진, rejected는 격리 */
  | { kind: 'confirm'; response: BatchResponse }
  /** 200이지만 본문 파싱 실패·batch_id 불일치·불변식 위반 → 전체 재전송 (멱등성이 흡수) */
  | { kind: 'resend'; reason: string }
  /** 401/403 — 키·매핑 문제는 재시도로 해결 불가 → 전송 중지 + 운영 경보 */
  | { kind: 'halt'; status: number }
  /** 400 — 구조 오류는 재전송해도 동일 결과 → 배치 격리 */
  | { kind: 'quarantine_batch' }
  /** 413 — 배치 이분할 재전송 */
  | { kind: 'split' }
  /** 429 — Retry-After + jitter 대기 후 재전송 */
  | { kind: 'rate_limited'; retryAfterSec: number }
  /** 5xx 등 — 지수 백오프 후 같은 event_id 재전송 (at-least-once) */
  | { kind: 'backoff'; status: number };

export function decideAck(
  status: number,
  bodyText: string,
  expectedBatchId: string,
  expectedEvents: readonly Pick<EventInput, 'event_id'>[],
  retryAfterHeader: string | null,
): AckAction {
  if (status === 200) {
    const validation = parseBatchResponse(
      bodyText,
      expectedBatchId,
      expectedEvents,
    );
    return validation.ok
      ? { kind: 'confirm', response: validation.response }
      : { kind: 'resend', reason: validation.reason };
  }
  if (status === 401 || status === 403) return { kind: 'halt', status };
  if (status === 400) return { kind: 'quarantine_batch' };
  if (status === 413) return { kind: 'split' };
  if (status === 429) {
    const parsed = Number(retryAfterHeader);
    return {
      kind: 'rate_limited',
      retryAfterSec: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    };
  }
  return { kind: 'backoff', status };
}
