/**
 * 고정 테스트 데이터셋 (design.md §12.1 표를 그대로 구현).
 *
 * 정답을 손으로 계산할 수 있도록 event_id까지 고정 상수다.
 * - 2026-01-01: 유저1·2 로그인, 유저1 결제 10,000원 (같은 event_id로 2회 등장),
 *               유저1 boss_clear (참여율 검증용)
 * - 2026-01-02: 유저1·2·3 로그인, 유저2 결제 5,000원
 * - 2026-01-08: 유저1·2 로그인 → 01-01 코호트 D7 = 1.0
 * - 2026-01-31: 유저1 로그인   → 01-01 코호트 D30 = 0.5
 *
 * 모든 occurred_at은 시간대 지정자(Z)를 포함한다 — 오프셋 없는 문자열은
 * 적재 시 rejected된다 (event-envelope.dto.ts).
 */
import type { EventInput } from '../../scripts/send-events';

/** .env.example / docker-compose 기본 INGEST_INSTANCE_ID와 동일 */
export const FIXTURE_INSTANCE_ID = '0fab3f2e-1894-41cd-b915-f99440a3ff32';

/** 고정 UUID: 마지막 12자리에 일련번호 (10진수 자릿수는 유효한 16진수이기도 함) */
function fixtureUuid(n: number): string {
  return `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
}

function ev(
  n: number,
  eventType: string,
  userId: number,
  occurredAt: string,
  payload: Record<string, unknown> = {},
): EventInput {
  return {
    instance_id: FIXTURE_INSTANCE_ID,
    event_id: fixtureUuid(n),
    event_type: eventType,
    user_id: userId,
    character_id: 100 + userId,
    session_id: `session-u${userId}-${occurredAt.slice(0, 10)}`,
    channel_id: 'channel-01',
    payload,
    occurred_at: occurredAt,
  };
}

// ── 2026-01-01 ──────────────────────────────────────────────
const LOGIN_U1_0101 = ev(1, 'session_login', 1, '2026-01-01T01:00:00.000Z', {
  platform: 'pc',
  client_version: '1.0.0',
});
const LOGIN_U2_0101 = ev(2, 'session_login', 2, '2026-01-01T01:10:00.000Z', {
  platform: 'mobile',
  client_version: '1.0.0',
});
/** 유저1 결제 10,000원 — 배열에 같은 event_id로 2회 등장 (중복 제거 검증) */
const PURCHASE_U1_0101 = ev(3, 'shop_purchase', 1, '2026-01-01T03:00:00.000Z', {
  order_id: 'ORDER-FIX-0001',
  product_id: 'cash-sword-001',
  product_name: '불꽃의 검',
  quantity: 1,
  amount_minor: 10000,
  currency: 'KRW',
});
/** 참여율 검증용 — 유저1만 boss_clear (01-01 DAU 2명 중 1명 → 0.5) */
const BOSS_U1_0101 = ev(4, 'boss_clear', 1, '2026-01-01T05:00:00.000Z', {
  boss_id: 'boss-01',
  difficulty: 'hard',
  clear_time_ms: 183000,
});

// ── 2026-01-02 ──────────────────────────────────────────────
const LOGIN_U1_0102 = ev(5, 'session_login', 1, '2026-01-02T01:00:00.000Z', {
  platform: 'pc',
  client_version: '1.0.0',
});
const LOGIN_U2_0102 = ev(6, 'session_login', 2, '2026-01-02T02:00:00.000Z', {
  platform: 'mobile',
  client_version: '1.0.0',
});
const LOGIN_U3_0102 = ev(7, 'session_login', 3, '2026-01-02T03:00:00.000Z', {
  platform: 'pc',
  client_version: '1.0.1',
});
const PURCHASE_U2_0102 = ev(8, 'shop_purchase', 2, '2026-01-02T04:00:00.000Z', {
  order_id: 'ORDER-FIX-0002',
  product_id: 'cash-potion-010',
  product_name: '엘릭서 묶음',
  quantity: 2,
  amount_minor: 5000, // 주문 총액 (수량 반영, A-28)
  currency: 'KRW',
});

// ── 2026-01-08 / 2026-01-31 ─────────────────────────────────
const LOGIN_U1_0108 = ev(9, 'session_login', 1, '2026-01-08T01:00:00.000Z', {
  platform: 'pc',
  client_version: '1.0.1',
});
const LOGIN_U2_0108 = ev(10, 'session_login', 2, '2026-01-08T02:00:00.000Z', {
  platform: 'mobile',
  client_version: '1.0.1',
});
const LOGIN_U1_0131 = ev(11, 'session_login', 1, '2026-01-31T01:00:00.000Z', {
  platform: 'pc',
  client_version: '1.0.2',
});

/**
 * 적재 순서 그대로의 이벤트 배열 (12건 — PURCHASE_U1_0101이 2회 등장).
 * 첫 적재 기대: received 12 / accepted 12 / stored 11 / duplicate 1
 */
export const DETERMINISTIC_EVENTS: EventInput[] = [
  LOGIN_U1_0101,
  LOGIN_U2_0101,
  PURCHASE_U1_0101,
  PURCHASE_U1_0101, // 같은 event_id 재전송 — 중복 제거 동작 증명 (spec 요구)
  BOSS_U1_0101,
  LOGIN_U1_0102,
  LOGIN_U2_0102,
  LOGIN_U3_0102,
  PURCHASE_U2_0102,
  LOGIN_U1_0108,
  LOGIN_U2_0108,
  LOGIN_U1_0131,
];

// ════════════════════════════════════════════════════════════
// 기대값 (design.md §12.1 표 + summary 기대값)
// ════════════════════════════════════════════════════════════

/** 첫 적재(빈 DB) 시의 적재 응답 기대값 */
export const EXPECTED_INGEST = {
  received: 12,
  accepted: 12,
  stored: 11,
  duplicate: 1,
  order_duplicate: 0,
  rejected: 0,
} as const;

/** 지표 조회 공통 기간 (01-01 ~ 01-02) */
export const FIXTURE_RANGE = { start: '2026-01-01', end: '2026-01-02' } as const;

export const EXPECTED_DAU = {
  summary: { unique_users: 3 },
  data: [
    { date: '2026-01-01', dau: 2 },
    { date: '2026-01-02', dau: 3 },
  ],
} as const;

export const EXPECTED_REVENUE = {
  summary: {
    currency: 'KRW',
    revenue_minor: '15000',
    active_users: 3,
    arpu_minor: '5000.00',
  },
  data: [
    {
      date: '2026-01-01',
      currency: 'KRW',
      revenue_minor: '10000',
      active_users: 2,
      arpu_minor: '5000.00',
    },
    {
      date: '2026-01-02',
      currency: 'KRW',
      revenue_minor: '5000',
      active_users: 3,
      arpu_minor: '1666.67',
    },
  ],
} as const;

export const EXPECTED_CONVERSION = {
  summary: { paying_users: 2, active_users: 3, conversion_rate: 0.6667 },
  data: [
    { date: '2026-01-01', paying_users: 1, active_users: 2, conversion_rate: 0.5 },
    { date: '2026-01-02', paying_users: 1, active_users: 3, conversion_rate: 0.3333 },
  ],
} as const;

/**
 * 리텐션 기대값 (코호트 01-01·01-02, exact-day).
 * 관찰 일자가 모두 지난 시점(2026-03-03 이후 조회) 기준 — matured 전부 true.
 */
export const EXPECTED_RETENTION = {
  data: [
    {
      cohort_date: '2026-01-01',
      new_users: 2,
      d1: 1.0, // 01-02에 유저1·2 모두 재로그인
      d7: 1.0, // 01-08에 유저1·2 모두 재로그인
      d30: 0.5, // 01-31에 유저1만 재로그인
      matured: { d1: true, d7: true, d30: true },
    },
    {
      cohort_date: '2026-01-02',
      new_users: 1, // 유저3 (유저1·2는 01-01 기존 유저)
      d1: 0,
      d7: 0,
      d30: 0,
      matured: { d1: true, d7: true, d30: true },
    },
  ],
} as const;

/** 참여율 기대값 — 01-01 boss_clear: DAU {1,2} 중 유저1만 → 0.5 */
export const EXPECTED_ENGAGEMENT_BOSS_CLEAR = {
  data: [
    {
      date: '2026-01-01',
      event_type: 'boss_clear',
      engaged_users: 1,
      dau: 2,
      engagement_rate: 0.5,
    },
  ],
} as const;
