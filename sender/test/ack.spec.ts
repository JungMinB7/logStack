import type { BatchResponse, EventInput } from '../../scripts/send-events';
import { decideAck } from '../src/ack';

const BATCH_ID = 'b8e7a2d0-0000-4000-8000-000000000001';
const EVENTS: Array<Pick<EventInput, 'event_id'>> = [
  { event_id: '00000000-0000-4000-8000-000000000001' },
  { event_id: '00000000-0000-4000-8000-000000000002' },
];

function okBody(overrides: Partial<BatchResponse> = {}): string {
  return JSON.stringify({
    batch_id: BATCH_ID,
    received_count: 2,
    accepted_count: 2,
    stored_count: 2,
    duplicate_count: 0,
    order_duplicate_count: 0,
    rejected_count: 0,
    rejected: [],
    ...overrides,
  });
}

function decide(
  status: number,
  body: string,
  retryAfter: string | null = null,
  events: Array<Pick<EventInput, 'event_id'>> = EVENTS,
) {
  return decideAck(status, body, BATCH_ID, events, retryAfter);
}

describe('decideAck — design.md §4.2 응답별 상태 전이 표', () => {
  it('200 + 파싱·batch_id·실제 배치 대조 통과 → confirm', () => {
    expect(decide(200, okBody()).kind).toBe('confirm');
  });

  it.each(['not-json', 'null', '[]'])('%s 200 본문 → 전체 재전송', (body) => {
    expect(decide(200, body)).toEqual({
      kind: 'resend',
      reason: body === 'not-json' ? 'body parse failed' : 'body schema invalid',
    });
  });

  it('200 + batch_id 불일치 → 전체 재전송', () => {
    expect(decide(200, okBody({ batch_id: 'another-id' }))).toEqual({
      kind: 'resend',
      reason: 'batch_id mismatch',
    });
  });

  it('200 + 카운트 불변식 위반 → 전체 재전송', () => {
    expect(decide(200, okBody({ stored_count: 1 }))).toEqual({
      kind: 'resend',
      reason: 'count invariant violated',
    });
  });

  it('received_count가 실제 전송 건수와 다르면 checkpoint 전진 불가', () => {
    expect(
      decide(
        200,
        okBody({
          received_count: 0,
          accepted_count: 0,
          stored_count: 0,
        }),
      ),
    ).toEqual({ kind: 'resend', reason: 'received_count mismatch' });
  });

  it.each([
    { rejected: [{ index: 2, code: 'BAD', message: 'bad' }] },
    { rejected: [{ index: 0.5, code: 'BAD', message: 'bad' }] },
    {
      rejected: [
        { index: 0, code: 'BAD', message: 'bad' },
        { index: 0, code: 'BAD', message: 'bad' },
      ],
    },
  ])('범위 밖·비정수·중복 rejected index는 재전송', ({ rejected }) => {
    expect(
      decide(
        200,
        okBody({
          accepted_count: 2 - rejected.length,
          stored_count: 2 - rejected.length,
          rejected_count: rejected.length,
          rejected,
        }),
      ),
    ).toEqual({ kind: 'resend', reason: 'rejected entry invalid' });
  });

  it('rejected.event_id가 해당 index 이벤트와 다르면 재전송', () => {
    expect(
      decide(
        200,
        okBody({
          accepted_count: 1,
          stored_count: 1,
          rejected_count: 1,
          rejected: [
            {
              index: 0,
              event_id: EVENTS[1].event_id,
              code: 'BAD',
              message: 'bad',
            },
          ],
        }),
      ),
    ).toEqual({ kind: 'resend', reason: 'rejected event_id mismatch' });
  });

  it.each([401, 403])('%s → 전송 중지', (status) => {
    expect(decide(status, '{}')).toEqual({ kind: 'halt', status });
  });

  it('400 → 배치 격리', () => {
    expect(decide(400, '{}')).toEqual({ kind: 'quarantine_batch' });
  });

  it('413 → 이분할 재전송', () => {
    expect(decide(413, '{}')).toEqual({ kind: 'split' });
  });

  it('429 → Retry-After 초를 담아 대기 (비정상이면 최소 1초)', () => {
    expect(decide(429, '{}', '39')).toEqual({
      kind: 'rate_limited',
      retryAfterSec: 39,
    });
    expect(decide(429, '{}')).toEqual({
      kind: 'rate_limited',
      retryAfterSec: 1,
    });
    expect(decide(429, '{}', 'abc')).toEqual({
      kind: 'rate_limited',
      retryAfterSec: 1,
    });
  });

  it.each([500, 502, 503])('%s → 지수 백오프 재전송', (status) => {
    expect(decide(status, '{}')).toEqual({ kind: 'backoff', status });
  });
});
