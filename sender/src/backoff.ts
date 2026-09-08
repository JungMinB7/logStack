/** 지수 백오프 기본값 — 1초에서 시작해 상한 30초 (design.md §4.2 — 5xx/timeout) */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;

/** attempt(0부터)에 대한 지수 백오프 지연: min(30s, 1s × 2^attempt) */
export function backoffDelayMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}

/**
 * 429 대기: Retry-After 초 + 랜덤 jitter(0~1초) — 모든 인스턴스가 동시에
 * 재개하는 것을 방지한다 (design.md §4.2).
 */
export function rateLimitedDelayMs(
  retryAfterSec: number,
  random: () => number = Math.random,
): number {
  return Math.max(1, retryAfterSec) * 1_000 + Math.floor(random() * 1_000);
}
