import {
  BACKOFF_CAP_MS,
  backoffDelayMs,
  rateLimitedDelayMs,
} from '../src/backoff';

describe('backoff — 지수 백오프(상한 30초)와 429 대기 (design.md §4.2)', () => {
  it('1초에서 시작해 2배씩 증가한다', () => {
    expect(backoffDelayMs(0)).toBe(1_000);
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(2)).toBe(4_000);
    expect(backoffDelayMs(4)).toBe(16_000);
  });

  it('상한 30초를 넘지 않는다', () => {
    expect(backoffDelayMs(5)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelayMs(20)).toBe(BACKOFF_CAP_MS);
  });

  it('429 대기 = Retry-After 초 + 0~1초 jitter (동시 재개 방지)', () => {
    expect(rateLimitedDelayMs(5, () => 0)).toBe(5_000);
    expect(rateLimitedDelayMs(5, () => 0.999)).toBe(5_999);
    // Retry-After가 0 이하로 와도 최소 1초는 대기한다
    expect(rateLimitedDelayMs(0, () => 0)).toBe(1_000);
  });
});
