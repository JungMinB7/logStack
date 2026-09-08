import { FixedWindowThrottle } from '../src/throttle';

describe('FixedWindowThrottle — 분당 고정 창 자체 스로틀 [A-25]', () => {
  const WINDOW = 60_000;

  it('한도 내에서는 슬롯을 소모하며 0을 반환한다', () => {
    let now = 120_000;
    const throttle = new FixedWindowThrottle(60, WINDOW, () => now);
    for (let i = 0; i < 60; i += 1) {
      expect(throttle.tryAcquire()).toBe(0);
      now += 100;
    }
  });

  it('한도 초과 시 다음 창까지 남은 ms를 반환한다 (슬롯 미소모)', () => {
    const windowStart = 120_000;
    let now = windowStart;
    const throttle = new FixedWindowThrottle(2, WINDOW, () => now);
    expect(throttle.tryAcquire()).toBe(0);
    expect(throttle.tryAcquire()).toBe(0);

    now = windowStart + 45_000; // 창 리셋까지 15초 남음
    expect(throttle.tryAcquire()).toBe(15_000);
  });

  it('창이 바뀌면 카운터가 리셋된다 (고정 창 — 슬라이딩 아님)', () => {
    let now = 120_000;
    const throttle = new FixedWindowThrottle(1, WINDOW, () => now);
    expect(throttle.tryAcquire()).toBe(0);
    expect(throttle.tryAcquire()).toBeGreaterThan(0);

    now = 120_000 + WINDOW; // 다음 창
    expect(throttle.tryAcquire()).toBe(0);
  });
});
