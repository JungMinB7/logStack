import { randomUUID } from 'node:crypto';
import { pickActivity } from '../../scripts/generate-events';
import type { EventInput } from '../../scripts/send-events';
import type { SenderConfig } from './config';

/**
 * 연속 이벤트 생성기 — 가상 유저 N명이 평균 rate건/초를 따르도록 생성한다 [A-5].
 * 활동 이벤트 분포는 과제 생성기(scripts/generate-events.ts의 ACTIVITIES)를
 * 재사용하고, 세션·결제 이벤트를 소량 섞는다 (design-aws.md §4-1).
 *
 * - occurred_at은 항상 toISOString() — 시간대 지정자 Z 포함 (없으면 서버가 rejected)
 * - order_id는 UUID 기반 전역 유일 [A-27]
 */
export class EventGenerator {
  private readonly config: Pick<
    SenderConfig,
    'instanceId' | 'users' | 'eventRate'
  >;
  private readonly rng: () => number;
  /** 세션 ID — 유저별로 프로세스 기동 단위 세션을 흉내낸다 */
  private readonly bootId = randomUUID().slice(0, 8);
  /** 인스턴스 10대가 같은 1001~1030을 재사용해 DAU가 30명으로 축소되지 않게 격리 */
  private readonly userIdBase: number;

  constructor(
    config: Pick<SenderConfig, 'instanceId' | 'users' | 'eventRate'>,
    rng: () => number = Math.random,
  ) {
    this.config = config;
    this.rng = rng;
    this.userIdBase = instanceUserIdBase(config.instanceId);
  }

  /** dtMs 동안 발생할 이벤트를 생성 (포아송 표본 — 평균 users×rate×dt) */
  tick(dtMs: number): EventInput[] {
    const lambda = this.config.users * this.config.eventRate * (dtMs / 1000);
    const count = poisson(lambda, this.rng);
    const events: EventInput[] = [];
    for (let i = 0; i < count; i += 1) {
      events.push(this.makeEvent());
    }
    return events;
  }

  private makeEvent(): EventInput {
    const userId = this.userIdBase + Math.floor(this.rng() * this.config.users);
    const base = {
      instance_id: this.config.instanceId,
      event_id: randomUUID(),
      user_id: userId,
      character_id: userId * 10 + 1,
      session_id: `s-${userId}-${this.bootId}`,
      channel_id: `channel-0${1 + (userId % 3)}`,
      occurred_at: new Date().toISOString(),
    };

    const r = this.rng();
    if (r < 0.08) {
      return {
        ...base,
        event_type: 'session_login',
        payload: {
          platform: this.rng() < 0.6 ? 'pc' : 'mobile',
          client_version: '1.0.0',
        },
      };
    }
    if (r < 0.13) {
      return {
        ...base,
        event_type: 'session_logout',
        payload: { duration_ms: Math.floor(this.rng() * 4 * 3600 * 1000), reason: 'user_quit' },
      };
    }
    if (r < 0.16) {
      const quantity = 1 + Math.floor(this.rng() * 3);
      return {
        ...base,
        event_type: 'shop_purchase',
        payload: {
          order_id: `ORDER-${randomUUID()}`, // 전역 유일 [A-27]
          product_id: `cash-item-${1 + Math.floor(this.rng() * 10)}`,
          product_name: `캐시 아이템 ${1 + Math.floor(this.rng() * 10)}`,
          quantity,
          amount_minor: quantity * (500 + Math.floor(this.rng() * 50) * 100),
          currency: 'KRW',
        },
      };
    }
    const activity = pickActivity(this.rng);
    return {
      ...base,
      event_type: activity.type,
      payload: activity.payload(this.rng),
    };
  }
}

/** A-4의 인스턴스당 최대 30명에 맞춘, JS safe-integer 내 안정적 사용자 ID 블록. */
export function instanceUserIdBase(instanceId: string): number {
  const compactUuid = instanceId.replaceAll('-', '');
  // character_id = user_id * 10 + 1까지 A-10의 safe-integer 범위에 남도록 제한한다.
  const namespace = BigInt(`0x${compactUuid}`) % 30_023_997_515_803n;
  return Number(namespace * 30n + 1n);
}

/** Knuth 포아송 표본 — lambda가 작을 때(틱당 수 건) 충분히 빠르다 */
function poisson(lambda: number, rng: () => number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}
