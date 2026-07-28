// 지표 API E2E (DAU·리텐션) — test/fixtures/deterministic-events.ts의
// 기대값 상수가 정답지다 (design.md §12.1). §12.2의 5·6·8 시나리오 포함.
// 전제: PostgreSQL 실행 중 (docker compose up -d db)

// ConfigService는 process.env를 우선 조회하므로 AppModule 로드 전에 고정한다.
process.env.INGEST_API_KEY = 'test-ingest-key';
process.env.INGEST_INSTANCE_ID = '0fab3f2e-1894-41cd-b915-f99440a3ff32';
process.env.ADMIN_API_KEY = 'test-admin-key';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type { EventInput } from '../scripts/send-events';
import {
  DETERMINISTIC_EVENTS,
  EXPECTED_CONVERSION,
  EXPECTED_DAU,
  EXPECTED_RETENTION,
  EXPECTED_REVENUE,
  FIXTURE_INSTANCE_ID,
  FIXTURE_RANGE,
} from './fixtures/deterministic-events';

const ADMIN_KEY = 'test-admin-key';
const INGEST_KEY = 'test-ingest-key';

describe('Metrics API — DAU & Retention (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.purchase.deleteMany();
    await prisma.gameEvent.deleteMany();
    await seedFixture();
  });

  /** 고정 데이터셋을 적재 API 경유로 투입 (적재 경로 검증 겸용) */
  async function seedFixture(extraEvents: EventInput[] = []): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/event-batches')
      .set('Authorization', `Bearer ${INGEST_KEY}`)
      .send({
        batch_id: randomUUID(),
        sent_at: new Date().toISOString(),
        events: [...DETERMINISTIC_EVENTS, ...extraEvents],
      })
      .expect(200);
  }

  function ingest(events: EventInput[]): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/event-batches')
      .set('Authorization', `Bearer ${INGEST_KEY}`)
      .send({
        batch_id: randomUUID(),
        sent_at: new Date().toISOString(),
        events,
      });
  }

  function getMetric(path: string, key: string = ADMIN_KEY): request.Test {
    return request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${key}`);
  }

  function loginEvent(
    userId: number,
    occurredAt: string,
  ): EventInput {
    return {
      instance_id: FIXTURE_INSTANCE_ID,
      event_id: randomUUID(),
      event_type: 'session_login',
      user_id: userId,
      character_id: 100 + userId,
      session_id: `session-extra-u${userId}`,
      channel_id: 'channel-01',
      payload: {},
      occurred_at: occurredAt,
    };
  }

  const { start, end } = FIXTURE_RANGE;

  it('DAU: EXPECTED_DAU와 일치 (zero-fill·정렬·meta 포함)', async () => {
    const res = await getMetric(
      `/api/v1/metrics/dau?start=${start}&end=${end}`,
    ).expect(200);

    expect(res.body).toEqual({
      meta: { start, end, page: 1, page_size: 31, total: 2 },
      summary: EXPECTED_DAU.summary,
      data: EXPECTED_DAU.data,
    });
  });

  it('DAU zero-fill: 이벤트 없는 날은 dau=0으로 반환', async () => {
    const res = await getMetric(
      `/api/v1/metrics/dau?start=${start}&end=2026-01-03`,
    ).expect(200);

    const body = res.body as {
      meta: { total: number };
      data: Array<{ date: string; dau: number }>;
    };
    expect(body.meta.total).toBe(3);
    expect(body.data).toHaveLength(3);
    expect(body.data[2]).toEqual({ date: '2026-01-03', dau: 0 });
    // summary는 zero-fill과 무관하게 기간 전체 고유 유저
    expect((res.body as { summary: unknown }).summary).toEqual({
      unique_users: 3,
    });
  });

  it('리텐션: EXPECTED_RETENTION과 일치 (1/1 코호트 d1=1.0, d7=1.0, d30=0.5)', async () => {
    const res = await getMetric(
      `/api/v1/metrics/retention?start=${start}&end=${end}`,
    ).expect(200);

    expect(res.body).toEqual({
      meta: { start, end, page: 1, page_size: 31, total: 2 },
      data: EXPECTED_RETENTION.data,
    });
  });

  it('과거 session_login이 늦게 도착하면 코호트 일자가 보정된다 (design.md §12.2-5)', async () => {
    // 유저3의 코호트는 01-02였으나, 더 이른 2025-12-30 로그인이 늦게 도착
    await ingest([loginEvent(3, '2025-12-30T10:00:00.000Z')]).expect(200);

    // 01-01~01-02 조회: 유저3은 더 이상 01-02 신규가 아님 → zero-fill 행
    const res = await getMetric(
      `/api/v1/metrics/retention?start=${start}&end=${end}`,
    ).expect(200);
    const body = res.body as { data: Array<Record<string, unknown>> };
    expect(body.data[1]).toEqual({
      cohort_date: '2026-01-02',
      new_users: 0,
      d1: null,
      d7: null,
      d30: null,
      matured: { d1: true, d7: true, d30: true },
    });

    // 보정된 코호트(2025-12-30)로 조회하면 유저3이 신규 1명으로 나타남
    const corrected = await getMetric(
      '/api/v1/metrics/retention?start=2025-12-30&end=2025-12-30',
    ).expect(200);
    const correctedBody = corrected.body as {
      data: Array<{ cohort_date: string; new_users: number }>;
    };
    expect(correctedBody.data).toHaveLength(1);
    expect(correctedBody.data[0]).toMatchObject({
      cohort_date: '2025-12-30',
      new_users: 1,
    });
  });

  it('UTC 자정 직전·직후 이벤트가 올바른 일자에 귀속된다 (design.md §12.2-6)', async () => {
    await ingest([
      loginEvent(900, '2026-01-04T23:59:59.999Z'), // 반개구간상 01-04
      loginEvent(901, '2026-01-05T00:00:00.000Z'), // 반개구간상 01-05
    ]).expect(200);

    const res = await getMetric(
      '/api/v1/metrics/dau?start=2026-01-04&end=2026-01-05',
    ).expect(200);
    expect((res.body as { data: unknown }).data).toEqual([
      { date: '2026-01-04', dau: 1 },
      { date: '2026-01-05', dau: 1 },
    ]);
  });

  it('미성숙 코호트는 dN=null, matured=false — 시간 고정 (design.md §12.2-8)', async () => {
    // 현재를 2026-01-09 정오(UTC)로 고정 — 01-01 코호트의 D7 관찰일(01-08)은
    // 끝났고(9 > 8), 01-02 코호트의 D7 관찰일(01-09)은 진행 중(9 > 9 false)
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-01-09T12:00:00.000Z').getTime());
    try {
      const res = await getMetric(
        `/api/v1/metrics/retention?start=${start}&end=${end}`,
      ).expect(200);
      expect((res.body as { data: unknown }).data).toEqual([
        {
          cohort_date: '2026-01-01',
          new_users: 2,
          d1: 1,
          d7: 1,
          d30: null, // 미성숙 → 0%가 아니라 null (AI_RULES 6)
          matured: { d1: true, d7: true, d30: false },
        },
        {
          cohort_date: '2026-01-02',
          new_users: 1,
          d1: 0, // 성숙했지만 아무도 안 돌아옴 → 숫자 0
          d7: null, // 관찰 일자(01-09) 진행 중 → null
          d30: null,
          matured: { d1: true, d7: false, d30: false },
        },
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  function purchaseEvent(
    userId: number,
    occurredAt: string,
    orderId: string,
    amountMinor: number,
  ): EventInput {
    return {
      instance_id: FIXTURE_INSTANCE_ID,
      event_id: randomUUID(),
      event_type: 'shop_purchase',
      user_id: userId,
      character_id: 100 + userId,
      session_id: `session-extra-u${userId}`,
      channel_id: 'channel-01',
      payload: {
        order_id: orderId,
        product_id: 'cash-item-x',
        product_name: 'extra item',
        quantity: 1,
        amount_minor: amountMinor,
        currency: 'KRW',
      },
      occurred_at: occurredAt,
    };
  }

  it('매출/ARPU: EXPECTED_REVENUE와 일치 (중복 event_id 2회 전송에도 매출 10000)', async () => {
    const res = await getMetric(
      `/api/v1/metrics/revenue?start=${start}&end=${end}&currency=KRW`,
    ).expect(200);

    expect(res.body).toEqual({
      meta: { start, end, page: 1, page_size: 31, total: 2 },
      summary: EXPECTED_REVENUE.summary, // revenue "15000", active 3, arpu "5000.00"
      data: EXPECTED_REVENUE.data, // 1/1: 10000·"5000.00", 1/2: 5000·"1666.67"
    });
  });

  it('결제 전환율: EXPECTED_CONVERSION과 일치 (1/1 0.5, summary 0.6667)', async () => {
    const res = await getMetric(
      `/api/v1/metrics/purchase-conversion?start=${start}&end=${end}`,
    ).expect(200);

    expect(res.body).toEqual({
      meta: { start, end, page: 1, page_size: 31, total: 2 },
      summary: EXPECTED_CONVERSION.summary, // 기간 고유 유저 재계산 (2/3=0.6667)
      data: EXPECTED_CONVERSION.data,
    });
  });

  it('전일 로그인 + 당일 결제 유저는 당일 분자에서 제외된다 (design.md §12.2-7)', async () => {
    await ingest([
      loginEvent(950, '2026-01-04T23:00:00.000Z'), // 전일 로그인
      purchaseEvent(950, '2026-01-05T01:00:00.000Z', 'ORDER-MIDNIGHT-1', 9900), // 당일 결제 (당일 로그인 없음)
      loginEvent(951, '2026-01-05T02:00:00.000Z'), // 당일 활성 유저는 별도로 존재
    ]).expect(200);

    const res = await getMetric(
      '/api/v1/metrics/purchase-conversion?start=2026-01-04&end=2026-01-05',
    ).expect(200);
    const body = res.body as {
      data: Array<{ conversion_rate: number | null }>;
      summary: unknown;
    };
    expect(body.data).toEqual([
      // 01-04: 활성 {950}, 결제∩활성 없음
      { date: '2026-01-04', paying_users: 0, active_users: 1, conversion_rate: 0 },
      // 01-05: 활성 {951}, 결제 유저 950은 당일 비활성 → 교집합 제외, ≤ 1.0 유지
      { date: '2026-01-05', paying_users: 0, active_users: 1, conversion_rate: 0 },
    ]);
    // 기간 전체 summary에서는 950이 (01-04 로그인 ∩ 기간 내 결제)로 포함된다
    expect(body.summary).toEqual({
      paying_users: 1,
      active_users: 2,
      conversion_rate: 0.5,
    });
  });

  it('amount_minor=0 결제도 결제 유저(PU)에 포함된다 [A-29]', async () => {
    await ingest([
      loginEvent(960, '2026-01-06T01:00:00.000Z'),
      purchaseEvent(960, '2026-01-06T02:00:00.000Z', 'ORDER-FREE-1', 0),
    ]).expect(200);

    const res = await getMetric(
      '/api/v1/metrics/purchase-conversion?start=2026-01-06&end=2026-01-06',
    ).expect(200);
    expect((res.body as { data: unknown }).data).toEqual([
      { date: '2026-01-06', paying_users: 1, active_users: 1, conversion_rate: 1 },
    ]);
  });

  it('활성 유저 0인 날 → revenue "0"/arpu null, 전환율 null (zero-fill)', async () => {
    const revenue = await getMetric(
      '/api/v1/metrics/revenue?start=2026-01-03&end=2026-01-03&currency=KRW',
    ).expect(200);
    expect((revenue.body as { data: unknown }).data).toEqual([
      {
        date: '2026-01-03',
        currency: 'KRW',
        revenue_minor: '0',
        active_users: 0,
        arpu_minor: null,
      },
    ]);
    expect((revenue.body as { summary: unknown }).summary).toEqual({
      currency: 'KRW',
      revenue_minor: '0',
      active_users: 0,
      arpu_minor: null,
    });

    const conversion = await getMetric(
      '/api/v1/metrics/purchase-conversion?start=2026-01-03&end=2026-01-03',
    ).expect(200);
    expect((conversion.body as { data: unknown }).data).toEqual([
      {
        date: '2026-01-03',
        paying_users: 0,
        active_users: 0,
        conversion_rate: null,
      },
    ]);
    expect((conversion.body as { summary: unknown }).summary).toEqual({
      paying_users: 0,
      active_users: 0,
      conversion_rate: null,
    });
  });

  it('currency 누락·형식 오류 → 400 INVALID_CURRENCY', async () => {
    const missing = await getMetric(
      `/api/v1/metrics/revenue?start=${start}&end=${end}`,
    ).expect(400);
    expect(missing.body).toMatchObject({ error: { code: 'INVALID_CURRENCY' } });

    const lowercase = await getMetric(
      `/api/v1/metrics/revenue?start=${start}&end=${end}&currency=krw`,
    ).expect(400);
    expect(lowercase.body).toMatchObject({
      error: { code: 'INVALID_CURRENCY' },
    });
  });

  it('잘못된 키 401 (적재 키로도 조회 불가)', async () => {
    await getMetric(`/api/v1/metrics/dau?start=${start}&end=${end}`, 'wrong')
      .expect(401);
    const res = await getMetric(
      `/api/v1/metrics/dau?start=${start}&end=${end}`,
      INGEST_KEY, // 적재 키는 조회 키가 아니다
    ).expect(401);
    expect(res.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('start > end → 400 INVALID_DATE_RANGE', async () => {
    const res = await getMetric(
      '/api/v1/metrics/dau?start=2026-01-02&end=2026-01-01',
    ).expect(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_DATE_RANGE' } });
  });

  it('367일 조회 → 400 RANGE_TOO_LARGE', async () => {
    const res = await getMetric(
      '/api/v1/metrics/retention?start=2026-01-01&end=2027-01-02',
    ).expect(400);
    expect(res.body).toMatchObject({ error: { code: 'RANGE_TOO_LARGE' } });
  });

  it('범위 밖 page → 200 + 빈 data (meta.total은 유지)', async () => {
    const res = await getMetric(
      `/api/v1/metrics/dau?start=${start}&end=${end}&page=99`,
    ).expect(200);
    const body = res.body as { meta: { total: number }; data: unknown[] };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(2);
  });
});
