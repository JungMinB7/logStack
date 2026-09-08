/**
 * 보조 이벤트 생성기 — 임의 기간·유저 수로 그럴듯한 게임 이벤트를 생성한다.
 *
 * - 시드 고정 LCG 난수로 재현 가능
 * - --duplicates: 생성된 이벤트 일부를 같은 event_id로 재등장시켜
 *   재전송 중복(멱등성) 시나리오를 만든다
 * - --shuffle: 시간순을 무작위로 뒤섞어 "이벤트는 시간순으로 도착하지 않는다"
 *   제약을 재현한다
 * - 모든 occurred_at은 Date.toISOString() 결과로 시간대 지정자(Z)를 포함한다
 *
 * 사용 (CLI):
 *   npx ts-node scripts/generate-events.ts \
 *     --users 10 --days 3 --start 2026-02-01 \
 *     [--per-user 20] [--duplicates 0.05] [--shuffle] [--seed 42] [--out events.json]
 */
import { writeFileSync } from 'node:fs';
import type { EventInput } from './send-events';

export interface GenerateOptions {
  users: number;
  /** YYYY-MM-DD (UTC) */
  startDate: string;
  days: number;
  /** 유저·일당 평균 활동 이벤트 수 (로그인 제외, 기본 20) */
  eventsPerUserPerDay?: number;
  /** 0~1 — 전체 대비 같은 event_id로 재등장시킬 비율 (기본 0) */
  duplicateRatio?: number;
  /** 시간순 뒤섞기 (기본 false) */
  shuffle?: boolean;
  seed?: number;
  instanceId?: string;
}

const DEFAULT_INSTANCE_ID = '0fab3f2e-1894-41cd-b915-f99440a3ff32';

/** 시드 고정 LCG — 재현 가능한 의사난수 [0, 1) */
function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** 난수 기반 UUID v4 형식 문자열 (시드 고정 시 결정적) */
function rngUuid(rng: () => number): string {
  const nibbles = Array.from({ length: 32 }, () =>
    Math.floor(rng() * 16).toString(16),
  );
  nibbles[12] = '4'; // version 4
  nibbles[16] = ((parseInt(nibbles[16], 16) & 0x3) | 0x8).toString(16); // variant
  const s = nibbles.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export interface ActivitySpec {
  type: string;
  weight: number;
  payload: (rng: () => number) => Record<string, unknown>;
}

/**
 * design.md §8.2의 payload 예시를 따르는 활동 이벤트 분포 (고빈도 이벤트 위주).
 * sender 데몬(sender/src/generator.ts)이 같은 분포를 재사용한다 (design-aws.md §4-1).
 */
export const ACTIVITIES: ActivitySpec[] = [
  {
    type: 'monster_kill',
    weight: 45,
    payload: (rng) => ({
      monster_id: `mob-${1 + Math.floor(rng() * 30)}`,
      map_id: `map-${1 + Math.floor(rng() * 8)}`,
    }),
  },
  {
    type: 'exp_gain',
    weight: 30,
    payload: (rng) => ({
      amount: 10 + Math.floor(rng() * 500),
      source_type: rng() < 0.7 ? 'hunt' : 'quest',
      map_id: `map-${1 + Math.floor(rng() * 8)}`,
    }),
  },
  {
    type: 'item_acquire',
    weight: 8,
    payload: (rng) => ({
      item_id: `item-${1 + Math.floor(rng() * 50)}`,
      quantity: 1 + Math.floor(rng() * 3),
      source_type: 'drop',
    }),
  },
  {
    type: 'map_enter',
    weight: 7,
    payload: (rng) => ({
      from_map_id: `map-${1 + Math.floor(rng() * 8)}`,
      to_map_id: `map-${1 + Math.floor(rng() * 8)}`,
    }),
  },
  {
    type: 'quest_complete',
    weight: 4,
    payload: (rng) => ({
      quest_id: `quest-${1 + Math.floor(rng() * 20)}`,
      reward_exp: 100 + Math.floor(rng() * 900),
    }),
  },
  {
    type: 'boss_clear',
    weight: 2,
    payload: (rng) => ({
      boss_id: `boss-${1 + Math.floor(rng() * 5)}`,
      difficulty: rng() < 0.5 ? 'normal' : 'hard',
      clear_time_ms: 60000 + Math.floor(rng() * 300000),
    }),
  },
  {
    type: 'level_up',
    weight: 2,
    payload: (rng) => {
      const from = 1 + Math.floor(rng() * 98);
      return { from_level: from, to_level: from + 1 };
    },
  },
  {
    type: 'death',
    weight: 2,
    payload: (rng) => ({
      map_id: `map-${1 + Math.floor(rng() * 8)}`,
      cause_type: rng() < 0.8 ? 'monster' : 'fall',
    }),
  },
];

export function pickActivity(rng: () => number): ActivitySpec {
  const total = ACTIVITIES.reduce((sum, a) => sum + a.weight, 0);
  let r = rng() * total;
  for (const activity of ACTIVITIES) {
    r -= activity.weight;
    if (r <= 0) return activity;
  }
  return ACTIVITIES[0];
}

export function generateEvents(options: GenerateOptions): EventInput[] {
  const rng = createRng(options.seed ?? 1);
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const perUserPerDay = options.eventsPerUserPerDay ?? 20;
  const [year, month, day] = options.startDate.split('-').map(Number);
  const events: EventInput[] = [];
  let orderSeq = 0;

  const iso = (dayOffset: number, msOfDay: number): string =>
    new Date(
      Date.UTC(year, month - 1, day + dayOffset, 0, 0, 0, msOfDay),
    ).toISOString(); // toISOString은 항상 Z(시간대 지정자)를 포함

  for (let d = 0; d < options.days; d += 1) {
    for (let u = 1; u <= options.users; u += 1) {
      if (rng() >= 0.8 && d > 0) continue; // 첫날 이후엔 80%만 접속

      const userId = 1000 + u;
      const sessionId = `session-u${userId}-d${d}-${Math.floor(rng() * 1e6)}`;
      const loginMs = Math.floor(rng() * 20 * 3600 * 1000); // 00~20시 사이 로그인
      const base = (n: number): Omit<EventInput, 'event_type' | 'payload'> => ({
        instance_id: instanceId,
        event_id: rngUuid(rng),
        user_id: userId,
        character_id: userId * 10 + 1,
        session_id: sessionId,
        channel_id: `channel-0${1 + (u % 3)}`,
        occurred_at: iso(d, n),
      });

      events.push({
        ...base(loginMs),
        event_type: 'session_login',
        payload: { platform: rng() < 0.6 ? 'pc' : 'mobile', client_version: '1.0.0' },
      });

      const activityCount = Math.max(
        1,
        Math.round(perUserPerDay * (0.5 + rng())),
      );
      for (let i = 0; i < activityCount; i += 1) {
        const at = loginMs + Math.floor(rng() * 3 * 3600 * 1000); // 로그인 후 3시간 내
        const activity = pickActivity(rng);
        events.push({
          ...base(at),
          event_type: activity.type,
          payload: activity.payload(rng),
        });
      }

      if (rng() < 0.15) {
        orderSeq += 1;
        const quantity = 1 + Math.floor(rng() * 3);
        events.push({
          ...base(loginMs + Math.floor(rng() * 3600 * 1000)),
          event_type: 'shop_purchase',
          payload: {
            order_id: `ORDER-GEN-${options.seed ?? 1}-${orderSeq}`,
            product_id: `cash-item-${1 + Math.floor(rng() * 10)}`,
            product_name: `캐시 아이템 ${1 + Math.floor(rng() * 10)}`,
            quantity,
            amount_minor: quantity * (500 + Math.floor(rng() * 50) * 100), // 주문 총액
            currency: 'KRW',
          },
        });
      }

      events.push({
        ...base(loginMs + 4 * 3600 * 1000),
        event_type: 'session_logout',
        payload: { duration_ms: 4 * 3600 * 1000, reason: 'user_quit' },
      });
    }
  }

  // 재전송 중복 재현: 일부 이벤트를 같은 event_id 그대로 재등장
  const duplicateRatio = options.duplicateRatio ?? 0;
  if (duplicateRatio > 0) {
    const count = Math.floor(events.length * duplicateRatio);
    for (let i = 0; i < count; i += 1) {
      const source = events[Math.floor(rng() * events.length)];
      events.push({ ...source });
    }
  }

  // 순서 역전 재현: Fisher–Yates 셔플
  if (options.shuffle) {
    for (let i = events.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [events[i], events[j]] = [events[j], events[i]];
    }
  }

  return events;
}

// ── CLI ─────────────────────────────────────────────────────
function parseArgs(argv: string[]): GenerateOptions & { out?: string } {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const users = Number(get('users') ?? 5);
  const days = Number(get('days') ?? 2);
  const startDate = get('start') ?? '2026-02-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !users || !days) {
    console.error(
      'usage: npx ts-node scripts/generate-events.ts --users 10 --days 3 --start 2026-02-01 [--per-user 20] [--duplicates 0.05] [--shuffle] [--seed 42] [--out events.json]',
    );
    process.exit(2);
  }
  return {
    users,
    days,
    startDate,
    eventsPerUserPerDay: Number(get('per-user') ?? 20),
    duplicateRatio: Number(get('duplicates') ?? 0),
    shuffle: argv.includes('--shuffle'),
    seed: Number(get('seed') ?? 1),
    out: get('out'),
  };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const events = generateEvents(options);
  const json = JSON.stringify(events, null, 2);
  if (options.out) {
    writeFileSync(options.out, json);
    console.log(`generated ${events.length} events → ${options.out}`);
  } else {
    console.log(json);
  }
}
