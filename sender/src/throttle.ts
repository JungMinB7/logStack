/**
 * 자체 스로틀: Date.now()를 epoch 60초 경계로 내린 고정 창, 기본 L=60.
 * receiver T2도 각 서버의 Date.now()를 같은 epoch 경계로 내린다. 시계가
 * 어긋나면 실제 창 경계는 일치하지 않는다. 알고리즘은 슬라이딩 창이 아니다.
 *
 * 시계 정상 진행·sender 1프로세스·재시작 없음: 각 정렬 창 <=L, 인접 두 창에
 * 걸친 짧은 구간 <=2L. 같은 정렬 창 안에서 정확히 1회 재시작하면 카운터
 * 리셋으로 그 창 <=2L, k회 재시작이면 <=(k+1)L. 반복 재시작의 횟수를
 * 제한하지 않으면 같은 분 120회라는 무조건적 상한은 없다. 여러 sender가
 * 같은 키를 쓰거나 시계가 역행하면 위 단일 프로세스 경계도 보장되지 않는다.
 *
 * 서버 429는 최후 방어선이다. 429 후 outbox 보존 및 Retry-After+jitter
 * 재전송은 복구 수단이지 sender 한도 준수나 무유실의 증명이 아니다.
 * 무유실은 독립 기록 ID와 DB/실패 저널의 최종 정합으로 별도 검증한다.
 * receiver도 메모리 카운터이므로 receiver 재시작은 서버 한도를 리셋한다.
 */
export class FixedWindowThrottle {
  private windowStart = -1;
  private count = 0;

  constructor(
    private readonly limitPerWindow: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 전송 슬롯 획득 시도.
   * @returns 0이면 슬롯 소모(즉시 전송 가능), 양수면 다음 창까지 대기할 ms
   */
  tryAcquire(): number {
    const nowMs = this.now();
    const windowStart = Math.floor(nowMs / this.windowMs) * this.windowMs;
    if (windowStart !== this.windowStart) {
      this.windowStart = windowStart;
      this.count = 0;
    }
    if (this.count < this.limitPerWindow) {
      this.count += 1;
      return 0;
    }
    return windowStart + this.windowMs - nowMs;
  }
}
