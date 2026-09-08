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
import { MetricsRepository } from '../src/metrics/metrics.repository';
import { DatabaseService } from '../src/database/database.service';
import type { EventInput } from '../scripts/send-events';
import {
  DETERMINISTIC_EVENTS,
  EXPECTED_CONVERSION,
  EXPECTED_DAU,
  EXPECTED_ENGAGEMENT_BOSS_CLEAR,
  EXPECTED_RETENTION,
  EXPECTED_REVENUE,
  FIXTURE_INSTANCE_ID,
  FIXTURE_RANGE,
} from './fixtures/deterministic-events';

const ADMIN_KEY = 'test-admin-key';
const INGEST_KEY = 'test-ingest-key';

describe('Metrics API — DAU & Retention (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: DatabaseService;
  let metricsRepository: MetricsRepository;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(DatabaseService);
    metricsRepository = app.get(MetricsRepository);
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

  it('[Codex 회귀] 동시 적재 중에도 DAU data와 summary는 같은 DB 스냅샷을 사용한다', async () => {
    // 두 읽기 쿼리 사이에 합법적인 동시 커밋을 결정적으로 끼워 넣는다.
    // 한 HTTP 응답 안의 data와 summary는 같은 시점의 지표여야 한다.
    // (Codex 원본에서 조정: 스파이가 인자를 그대로 전달해 트랜잭션 클라이언트가
    // 보존되도록 했고, 재시도·타이머 없이 promise 게이트만 사용해 flaky하지 않다)
    let markDailyReadComplete!: () => void;
    const dailyReadComplete = new Promise<void>((resolve) => {
      markDailyReadComplete = resolve;
    });
    const originalDauByDay = metricsRepository.dauByDay.bind(metricsRepository);
    const originalUniqueLoginUsers =
      metricsRepository.uniqueLoginUsers.bind(metricsRepository);
    const dauSpy = jest
      .spyOn(metricsRepository, 'dauByDay')
      .mockImplementationOnce(
        async (...args: Parameters<MetricsRepository['dauByDay']>) => {
          const dauRows = await originalDauByDay(...args);
          markDailyReadComplete();
          return dauRows;
        },
      );
    const summarySpy = jest
      .spyOn(metricsRepository, 'uniqueLoginUsers')
      .mockImplementationOnce(
        async (...args: Parameters<MetricsRepository['uniqueLoginUsers']>) => {
          await dailyReadComplete;
          // 일별 읽기와 summary 읽기 사이에 새 로그인이 커밋된다
          await ingest([
            loginEvent(777_001, '2042-01-01T12:00:00.000Z'),
          ]).expect(200);
          return originalUniqueLoginUsers(...args);
        },
      );

    try {
      const res = await getMetric(
        '/api/v1/metrics/dau?start=2042-01-01&end=2042-01-01',
      ).expect(200);
      const body = res.body as {
        summary: { unique_users: number };
        data: Array<{ date: string; dau: number }>;
      };

      expect(body.data).toHaveLength(1);
      expect(body.summary.unique_users).toBe(body.data[0].dau);
    } finally {
      dauSpy.mockRestore();
      summarySpy.mockRestore();
    }
  });

  it(
    '[Codex fix 검증] 스냅샷 트랜잭션 만료는 재시도 가능한 503으로 반환한다',
    async () => {
      // 각 SQL은 statement_timeout(5초)보다 짧지만, 합계(4.5초×2 = 9초)는
      // 스냅샷 트랜잭션 timeout(8초 — design.md §6.4 체계)을 넘긴다.
      // DB timeout은 문서 계약대로 500이 아닌 503 STORAGE_UNAVAILABLE이어야 한다.
      const originalDauByDay =
        metricsRepository.dauByDay.bind(metricsRepository);
      const originalUniqueLoginUsers =
        metricsRepository.uniqueLoginUsers.bind(metricsRepository);
      const dauSpy = jest
        .spyOn(metricsRepository, 'dauByDay')
        .mockImplementationOnce(
          async (...args: Parameters<MetricsRepository['dauByDay']>) => {
            const tx = args[2];
            if (!tx) throw new Error('snapshot transaction client is missing');
            await tx.$queryRawUnsafe(
              'SELECT 1::int AS n FROM pg_sleep(4.5)',
            );
            return originalDauByDay(...args);
          },
        );
      const summarySpy = jest
        .spyOn(metricsRepository, 'uniqueLoginUsers')
        .mockImplementationOnce(
          async (
            ...args: Parameters<MetricsRepository['uniqueLoginUsers']>
          ) => {
            const tx = args[2];
            if (!tx) throw new Error('snapshot transaction client is missing');
            await tx.$queryRawUnsafe(
              'SELECT 1::int AS n FROM pg_sleep(4.5)',
            );
            return originalUniqueLoginUsers(...args);
          },
        );

      try {
        const res = await getMetric(
          '/api/v1/metrics/dau?start=2026-01-01&end=2026-01-01',
        ).expect(503);
        expect(res.body).toEqual({
          error: {
            code: 'STORAGE_UNAVAILABLE',
            message: expect.any(String) as string,
          },
        });
      } finally {
        dauSpy.mockRestore();
        summarySpy.mockRestore();
      }
    },
    20_000,
  );

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
    currency: string = 'KRW',
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
        currency,
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

  it('[Codex 회귀] 안전 정수 결제의 기간 합계가 BIGINT를 넘어도 문자열로 응답한다', async () => {
    // 개별 amount_minor는 A-10의 Number.MAX_SAFE_INTEGER 범위 안이지만,
    // 1,025건의 합계는 PostgreSQL signed BIGINT 범위를 넘는다.
    const amountMinor = Number.MAX_SAFE_INTEGER;
    const events = Array.from({ length: 1_025 }, (_, i) =>
      purchaseEvent(
        800_000 + i,
        '2041-01-01T12:00:00.000Z',
        `ORDER-BIGINT-SUM-${i}`,
        amountMinor,
        'JPY',
      ),
    );
    for (let offset = 0; offset < events.length; offset += 500) {
      const batch = events.slice(offset, offset + 500);
      const ingested = await ingest(batch).expect(200);
      expect(
        (ingested.body as { stored_count: number }).stored_count,
      ).toBe(batch.length);
    }

    const expectedRevenue = (BigInt(amountMinor) * 1_025n).toString();
    const res = await getMetric(
      '/api/v1/metrics/revenue?start=2041-01-01&end=2041-01-01&currency=JPY',
    ).expect(200);

    expect(
      (res.body as { summary: { revenue_minor: string } }).summary
        .revenue_minor,
    ).toBe(expectedRevenue);
    expect(
      (res.body as { data: Array<{ revenue_minor: string }> }).data[0]
        .revenue_minor,
    ).toBe(expectedRevenue);
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

  function activityEvent(
    userId: number,
    eventType: string,
    occurredAt: string,
    payload: Record<string, unknown> = {},
  ): EventInput {
    return {
      instance_id: FIXTURE_INSTANCE_ID,
      event_id: randomUUID(),
      event_type: eventType,
      user_id: userId,
      character_id: 100 + userId,
      session_id: `session-extra-u${userId}`,
      channel_id: 'channel-01',
      payload,
      occurred_at: occurredAt,
    };
  }

  it('참여율: 1/1 boss_clear = 0.5 (유저1만 참여, DAU 2)', async () => {
    const res = await getMetric(
      '/api/v1/metrics/engagement?start=2026-01-01&end=2026-01-01&event_type=boss_clear',
    ).expect(200);

    expect(res.body).toEqual({
      meta: {
        start: '2026-01-01',
        end: '2026-01-01',
        page: 1,
        page_size: 31,
        total: 1,
      },
      data: EXPECTED_ENGAGEMENT_BOSS_CLEAR.data,
    });
  });

  it('전일 로그인 유저의 당일 boss_clear는 당일 분자에서 제외된다 (교집합, ≤ 1.0)', async () => {
    await ingest([
      loginEvent(970, '2026-01-04T23:00:00.000Z'), // 전일 로그인
      activityEvent(970, 'boss_clear', '2026-01-05T01:00:00.000Z', {
        boss_id: 'boss-02',
      }), // 당일 활동 (당일 로그인 없음)
      loginEvent(971, '2026-01-05T02:00:00.000Z'), // 당일 DAU 구성원
    ]).expect(200);

    const res = await getMetric(
      '/api/v1/metrics/engagement?start=2026-01-05&end=2026-01-05&event_type=boss_clear',
    ).expect(200);
    // 유저970은 당일 DAU 집합 밖 → 분자 제외. 0 ≤ rate ≤ 1 유지
    expect((res.body as { data: unknown }).data).toEqual([
      {
        date: '2026-01-05',
        event_type: 'boss_clear',
        engaged_users: 0,
        dau: 1,
        engagement_rate: 0,
      },
    ]);
  });

  it('event_type 생략 시 (달력 일수 × 13) 행 + 페이지네이션·정렬 동작', async () => {
    // 2일 × 13타입 = 26행, 기본 page_size 31이면 한 페이지에 전부
    const res = await getMetric(
      `/api/v1/metrics/engagement?start=${start}&end=${end}`,
    ).expect(200);
    const body = res.body as {
      meta: { total: number };
      data: Array<{
        date: string;
        event_type: string;
        engaged_users: number;
        dau: number;
        engagement_rate: number | null;
      }>;
    };
    expect(body.meta.total).toBe(26);
    expect(body.data).toHaveLength(26);
    // 정렬: date ASC, event_type ASC
    const sorted = [...body.data].sort((a, b) =>
      a.date === b.date
        ? a.event_type.localeCompare(b.event_type)
        : a.date.localeCompare(b.date),
    );
    expect(body.data).toEqual(sorted);
    // 고정 데이터셋 spot check: 01-01 boss_clear 0.5, session_login 1.0
    expect(
      body.data.find(
        (r) => r.date === '2026-01-01' && r.event_type === 'boss_clear',
      ),
    ).toEqual({
      date: '2026-01-01',
      event_type: 'boss_clear',
      engaged_users: 1,
      dau: 2,
      engagement_rate: 0.5,
    });
    expect(
      body.data.find(
        (r) => r.date === '2026-01-01' && r.event_type === 'session_login',
      ),
    ).toMatchObject({ engaged_users: 2, dau: 2, engagement_rate: 1 });

    // 페이지네이션: page_size=10, page=3 → 21~26번째 행 (6개), total 유지
    const page3 = await getMetric(
      `/api/v1/metrics/engagement?start=${start}&end=${end}&page=3&page_size=10`,
    ).expect(200);
    const page3Body = page3.body as {
      meta: { total: number; page: number; page_size: number };
      data: unknown[];
    };
    expect(page3Body.meta).toMatchObject({ total: 26, page: 3, page_size: 10 });
    expect(page3Body.data).toHaveLength(6);
    expect(page3Body.data).toEqual(body.data.slice(20));
  });

  it('목록 밖 event_type → 400 UNKNOWN_EVENT_TYPE', async () => {
    const res = await getMetric(
      `/api/v1/metrics/engagement?start=${start}&end=${end}&event_type=teleport`,
    ).expect(400);
    expect(res.body).toMatchObject({ error: { code: 'UNKNOWN_EVENT_TYPE' } });
  });

  it('[회귀] 통화 혼합: currency=KRW는 KRW만, USD는 USD만 집계 (AI_RULES 5)', async () => {
    await ingest([
      loginEvent(940, '2026-01-10T01:00:00.000Z'),
      purchaseEvent(940, '2026-01-10T02:00:00.000Z', 'ORDER-MIX-KRW', 100),
      purchaseEvent(940, '2026-01-10T03:00:00.000Z', 'ORDER-MIX-USD', 7777, 'USD'),
    ]).expect(200);

    const krw = await getMetric(
      '/api/v1/metrics/revenue?start=2026-01-10&end=2026-01-10&currency=KRW',
    ).expect(200);
    expect((krw.body as { data: unknown }).data).toEqual([
      {
        date: '2026-01-10',
        currency: 'KRW',
        revenue_minor: '100', // USD 7777이 섞이지 않아야 함
        active_users: 1,
        arpu_minor: '100.00',
      },
    ]);
    expect((krw.body as { summary: unknown }).summary).toEqual({
      currency: 'KRW',
      revenue_minor: '100',
      active_users: 1,
      arpu_minor: '100.00',
    });

    const usd = await getMetric(
      '/api/v1/metrics/revenue?start=2026-01-10&end=2026-01-10&currency=USD',
    ).expect(200);
    expect((usd.body as { data: unknown }).data).toEqual([
      {
        date: '2026-01-10',
        currency: 'USD',
        revenue_minor: '7777',
        active_users: 1,
        arpu_minor: '7777.00',
      },
    ]);
  });

  it('[회귀] 기간 summary 교집합: 로그인이 기간 밖에만 있는 결제 유저는 분자 제외 (AI_RULES 21)', async () => {
    await ingest([
      loginEvent(990, '2026-01-20T01:00:00.000Z'), // 기간 내 활성 유저
      purchaseEvent(991, '2026-01-20T02:00:00.000Z', 'ORDER-OUT-1', 500), // 기간 내 결제
      loginEvent(991, '2026-01-25T01:00:00.000Z'), // 991의 로그인은 기간 밖에만 존재
    ]).expect(200);

    const res = await getMetric(
      '/api/v1/metrics/purchase-conversion?start=2026-01-19&end=2026-01-20',
    ).expect(200);
    const body = res.body as {
      summary: { paying_users: number; conversion_rate: number | null };
      data: Array<{ conversion_rate: number | null }>;
    };
    // 991은 기간 내 결제자이지만 기간 내 활성 집합 밖 → summary 분자에서 제외
    expect(body.summary).toEqual({
      paying_users: 0,
      active_users: 1,
      conversion_rate: 0,
    });
    for (const row of body.data) {
      if (row.conversion_rate !== null) {
        expect(row.conversion_rate).toBeLessThanOrEqual(1);
      }
    }
  });

  it('[회귀] summary는 페이지네이션과 독립 — page=2에서도 동일 (AI_RULES 23)', async () => {
    const paths = [
      `/api/v1/metrics/dau?start=${start}&end=${end}`,
      `/api/v1/metrics/revenue?start=${start}&end=${end}&currency=KRW`,
      `/api/v1/metrics/purchase-conversion?start=${start}&end=${end}`,
    ];
    for (const path of paths) {
      const page1 = await getMetric(path).expect(200);
      const page2 = await getMetric(`${path}&page=2&page_size=1`).expect(200);
      const body1 = page1.body as {
        meta: { total: number };
        summary: unknown;
        data: unknown[];
      };
      const body2 = page2.body as {
        meta: { total: number };
        summary: unknown;
        data: unknown[];
      };
      expect(body2.summary).toEqual(body1.summary); // summary 불변
      expect(body2.meta.total).toBe(body1.meta.total); // total 불변
      expect(body2.data).toEqual([body1.data[1]]); // 2페이지 = 전체의 2번째 행
    }
  });

  it('[회귀] 결제의 자정 경계: 23:59:59.999Z → 당일, 00:00:00.000Z → 익일 귀속', async () => {
    await ingest([
      loginEvent(930, '2026-01-10T01:00:00.000Z'),
      purchaseEvent(930, '2026-01-10T23:59:59.999Z', 'ORDER-MID-1', 100),
      purchaseEvent(930, '2026-01-11T00:00:00.000Z', 'ORDER-MID-2', 200),
    ]).expect(200);

    const res = await getMetric(
      '/api/v1/metrics/revenue?start=2026-01-10&end=2026-01-11&currency=KRW',
    ).expect(200);
    expect((res.body as { data: unknown }).data).toEqual([
      {
        date: '2026-01-10',
        currency: 'KRW',
        revenue_minor: '100', // 23:59:59.999는 반개구간상 당일
        active_users: 1,
        arpu_minor: '100.00',
      },
      {
        date: '2026-01-11',
        currency: 'KRW',
        revenue_minor: '200', // 00:00:00.000은 익일
        active_users: 0,
        arpu_minor: null,
      },
    ]);
  });

  it('[회귀] 고정 데이터셋 전량 재전송 후 5개 지표 응답이 동일하다', async () => {
    const paths = [
      `/api/v1/metrics/dau?start=${start}&end=${end}`,
      `/api/v1/metrics/retention?start=${start}&end=${end}`,
      `/api/v1/metrics/revenue?start=${start}&end=${end}&currency=KRW`,
      `/api/v1/metrics/purchase-conversion?start=${start}&end=${end}`,
      `/api/v1/metrics/engagement?start=${start}&end=${end}`,
    ];
    const before: unknown[] = [];
    for (const path of paths) {
      before.push((await getMetric(path).expect(200)).body);
    }

    // 커밋 후 응답 유실을 가정한 전량 재전송 — 전부 duplicate여야 한다
    await seedFixture();

    for (let i = 0; i < paths.length; i += 1) {
      const after = (await getMetric(paths[i]).expect(200)).body as unknown;
      expect(after).toEqual(before[i]); // deep-equal 완전 동일
    }
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

  it('[Codex 회귀] PostgreSQL에 존재하지 않는 year 0000은 500이 아니라 400', async () => {
    const res = await getMetric(
      '/api/v1/metrics/dau?start=0000-01-01&end=0000-01-01',
    ).expect(400);
    expect(res.body).toMatchObject({
      error: { code: 'INVALID_DATE_RANGE' },
    });
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
