import { ACTIVITIES } from '../../scripts/generate-events';
import { EventGenerator, instanceUserIdBase } from '../src/generator';

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('EventGenerator — 30명 × 평균 0.5건/초 [A-5]', () => {
  it('장기 표본 평균과 generate-events 활동 분포, UTC Z를 만족한다', () => {
    const generator = new EventGenerator(
      {
        instanceId: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
        users: 30,
        eventRate: 0.5,
      },
      seededRng(42),
    );
    const durationSec = 1_000;
    const events = Array.from({ length: durationSec * 5 }).flatMap(() =>
      generator.tick(200),
    );

    const observedPerUserPerSec = events.length / 30 / durationSec;
    expect(observedPerUserPerSec).toBeGreaterThan(0.47);
    expect(observedPerUserPerSec).toBeLessThan(0.53);
    expect(events.every((event) => event.occurred_at.endsWith('Z'))).toBe(true);
    const userIdBase = instanceUserIdBase(
      '0fab3f2e-1894-41cd-b915-f99440a3ff32',
    );
    expect(
      events.every(
        (event) =>
          event.user_id >= userIdBase && event.user_id < userIdBase + 30,
      ),
    ).toBe(true);

    const reusableActivityTypes = new Set(
      ACTIVITIES.map((activity) => activity.type),
    );
    const emittedActivityTypes = new Set(
      events
        .filter((event) => reusableActivityTypes.has(event.event_type))
        .map((event) => event.event_type),
    );
    expect(emittedActivityTypes).toEqual(reusableActivityTypes);
  });

  it('서로 다른 instance_id는 겹치지 않는 30명 사용자 블록을 사용한다', () => {
    const first = instanceUserIdBase(
      '0fab3f2e-1894-41cd-b915-f99440a3ff32',
    );
    const second = instanceUserIdBase(
      '1fab3f2e-1894-41cd-b915-f99440a3ff32',
    );

    expect(first).not.toBe(second);
    expect(Math.abs(first - second)).toBeGreaterThanOrEqual(30);
    expect(first + 29).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(second + 29).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect((first + 29) * 10 + 1).toBeLessThanOrEqual(
      Number.MAX_SAFE_INTEGER,
    );
    expect((second + 29) * 10 + 1).toBeLessThanOrEqual(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
