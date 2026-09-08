import { Injectable } from '@nestjs/common';

/** 고정 창 크기: 1분 — 과제 전송 제약 "120회/분"의 창 정의 [A-25] */
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface ConsumeResult {
  /** 한도 이내 여부 — false면 요청을 거절(429)해야 한다 */
  allowed: boolean;
  /** 현재 창에서 이 키가 보낸 요청 수 (이번 요청 포함) — 관측 로그 재료 (§6.5) */
  count: number;
  /** 거절 시 창 리셋까지 남은 초 (최소 1). 허용 시 0 */
  retryAfterSec: number;
}

/**
 * 키(=인스턴스) 단위 고정 1분 창 rate limit 카운터 (design-aws.md §5).
 *
 * 저장소는 인메모리 Map — 수신 서버 1대 전제(과제·AWS 구성 모두 수신 ×1).
 * 수신 서버를 다중화하면 서버별 카운터가 분리되어 실효 한도가 대수만큼
 * 늘어나므로, 그 시점에는 공유 저장소 기반 분산 rate limit이 필요하다
 * (design.md §15 "다중 적재 서버 — 서버 인스턴스 간 공유하는 분산 rate limit").
 *
 * - 키 수는 인스턴스 수(과제 1개, AWS 10개)로 유한하여 축출(eviction)은 두지 않는다
 * - Date.now() 기반 — 테스트에서 jest.spyOn(Date, 'now')로 시간 제어 가능
 *   (기존 리텐션 matured 테스트와 같은 패턴)
 */
@Injectable()
export class RateLimitStore {
  private readonly windows = new Map<
    string,
    { windowStart: number; count: number }
  >();

  consume(key: string, limit: number): ConsumeResult {
    const now = Date.now();
    const windowStart =
      Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;

    const state = this.windows.get(key);
    if (!state || state.windowStart !== windowStart) {
      // 새 창 시작 — 이전 창의 카운트는 폐기 (고정 창, 슬라이딩 아님 [A-25])
      this.windows.set(key, { windowStart, count: 1 });
      return { allowed: true, count: 1, retryAfterSec: 0 };
    }

    state.count += 1;
    if (state.count <= limit) {
      return { allowed: true, count: state.count, retryAfterSec: 0 };
    }
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
    );
    return { allowed: false, count: state.count, retryAfterSec };
  }
}
