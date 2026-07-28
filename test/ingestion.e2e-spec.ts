// 적재 API E2E — docs/api.openapi.yaml의 /api/v1/event-batches 계약과
// design.md §12.2의 시나리오(2, 3, 4, 9, 10)를 검증한다.
// 전제: PostgreSQL 실행 중 (docker compose up -d db)

// ConfigService는 process.env를 우선 조회하므로 AppModule 로드 전에 고정한다.
process.env.INGEST_API_KEY = 'test-ingest-key';
process.env.INGEST_INSTANCE_ID = '0fab3f2e-1894-41cd-b915-f99440a3ff32';
process.env.ADMIN_API_KEY ??= 'test-admin-key'; // fail-closed 부팅 요건

import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const API_KEY = 'test-ingest-key';
const INSTANCE_ID = '0fab3f2e-1894-41cd-b915-f99440a3ff32';
const PATH = '/api/v1/event-batches';

interface EventOverrides {
  event_id?: string;
  event_type?: string;
  instance_id?: string;
  user_id?: number;
  payload?: unknown;
  occurred_at?: string;
}

function makeEvent(overrides: EventOverrides = {}): Record<string, unknown> {
  return {
    instance_id: INSTANCE_ID,
    event_id: randomUUID(),
    event_type: 'session_login',
    user_id: 1001,
    character_id: 2001,
    session_id: 'session-abc',
    channel_id: 'channel-01',
    payload: {},
    occurred_at: '2026-01-01T04:15:22.123Z',
    ...overrides,
  };
}

function makePurchaseEvent(
  orderId: string,
  overrides: EventOverrides = {},
): Record<string, unknown> {
  return makeEvent({
    event_type: 'shop_purchase',
    payload: {
      order_id: orderId,
      product_id: 'cash-sword-001',
      product_name: '불꽃의 검',
      quantity: 1,
      amount_minor: 9900,
      currency: 'KRW',
    },
    ...overrides,
  });
}

function makeBatch(events: unknown[]): Record<string, unknown> {
  return {
    batch_id: randomUUID(),
    sent_at: new Date().toISOString(),
    events,
  };
}

interface BatchResponseBody {
  batch_id: string;
  received_count: number;
  accepted_count: number;
  stored_count: number;
  duplicate_count: number;
  order_duplicate_count: number;
  rejected_count: number;
  rejected: Array<{
    index: number;
    event_id?: string;
    code: string;
    message: string;
  }>;
}

/** 카운트 불변식 (AI_RULES 18) — 모든 적재 E2E에서 검증 */
function assertInvariants(body: BatchResponseBody): void {
  expect(body.received_count).toBe(body.accepted_count + body.rejected_count);
  expect(body.accepted_count).toBe(body.stored_count + body.duplicate_count);
  expect(body.order_duplicate_count).toBeLessThanOrEqual(body.stored_count);
  expect(body.rejected).toHaveLength(body.rejected_count);
}

describe('Ingestion API (e2e)', () => {
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
  });

  function post(batch: unknown, key: string = API_KEY): request.Test {
    return request(app.getHttpServer())
      .post(PATH)
      .set('Authorization', `Bearer ${key}`)
      .send(batch as object);
  }

  it('1. 정상 배치 → 200, 전량 stored, 불변식 성립', async () => {
    const batch = makeBatch([
      makeEvent({ user_id: 1001 }),
      makeEvent({ event_type: 'monster_kill', payload: { monster_id: 'm-1' } }),
      makePurchaseEvent('ORDER-0001'),
    ]);

    const res = await post(batch).expect(200);
    const body = res.body as BatchResponseBody;

    expect(body.batch_id).toBe(batch.batch_id);
    expect(body.received_count).toBe(3);
    expect(body.accepted_count).toBe(3);
    expect(body.stored_count).toBe(3);
    expect(body.duplicate_count).toBe(0);
    expect(body.order_duplicate_count).toBe(0);
    expect(body.rejected_count).toBe(0);
    assertInvariants(body);

    expect(await prisma.gameEvent.count()).toBe(3);
    expect(await prisma.purchase.count()).toBe(1);
  });

  it('2. 같은 배치 재전송 → 전량 duplicate, 행 수·매출 불변 (design.md §12.2-3)', async () => {
    const batch = makeBatch([
      makeEvent(),
      makePurchaseEvent('ORDER-1001'),
    ]);

    const first = await post(batch).expect(200);
    expect((first.body as BatchResponseBody).stored_count).toBe(2);

    // 커밋 후 응답 유실을 가정한 전체 배치 재전송
    const second = await post(batch).expect(200);
    const body = second.body as BatchResponseBody;

    expect(body.received_count).toBe(2);
    expect(body.accepted_count).toBe(2);
    expect(body.stored_count).toBe(0);
    expect(body.duplicate_count).toBe(2);
    expect(body.order_duplicate_count).toBe(0);
    expect(body.rejected_count).toBe(0);
    assertInvariants(body);

    expect(await prisma.gameEvent.count()).toBe(2);
    expect(await prisma.purchase.count()).toBe(1);
    const revenue = await prisma.purchase.aggregate({
      _sum: { amountMinor: true },
    });
    expect(revenue._sum.amountMinor).toBe(9900n);
  });

  it('3. 다른 event_id + 같은 order_id → 원본 저장, 파생만 생략, order_duplicate 보고 (design.md §12.2-2)', async () => {
    await post(makeBatch([makePurchaseEvent('ORDER-2001')])).expect(200);

    // 같은 주문이 버그로 다른 event_id로 재전송된 상황
    const res = await post(makeBatch([makePurchaseEvent('ORDER-2001')])).expect(
      200,
    );
    const body = res.body as BatchResponseBody;

    expect(body.stored_count).toBe(1); // 원본은 저장
    expect(body.duplicate_count).toBe(0);
    expect(body.order_duplicate_count).toBe(1); // 결제 파생만 생략
    assertInvariants(body);

    expect(await prisma.gameEvent.count()).toBe(2); // 원본 2건
    expect(await prisma.purchase.count()).toBe(1); // 결제 1건 — 매출 중복 차단
  });

  it('4. 혼합 배치(1건 invalid) → 정상 저장 + rejected, 불변식 성립 (design.md §12.2-4)', async () => {
    const invalidId = randomUUID();
    const batch = makeBatch([
      makeEvent(),
      makePurchaseEvent('ORDER-3001', {
        event_id: invalidId,
        payload: {
          order_id: 'ORDER-3001',
          product_id: 'p-1',
          product_name: 'x',
          quantity: 0, // CHECK 위반 값 — payload 검증에서 거절되어야 함
          amount_minor: 9900,
          currency: 'KRW',
        },
      }),
      makeEvent({ event_type: 'boss_clear', payload: { boss_id: 'b-1' } }),
    ]);

    const res = await post(batch).expect(200);
    const body = res.body as BatchResponseBody;

    expect(body.received_count).toBe(3);
    expect(body.accepted_count).toBe(2);
    expect(body.stored_count).toBe(2);
    expect(body.rejected_count).toBe(1);
    expect(body.rejected[0]).toMatchObject({
      index: 1,
      event_id: invalidId,
      code: 'INVALID_PAYLOAD',
    });
    expect(body.rejected[0].message.length).toBeLessThanOrEqual(200);
    assertInvariants(body);

    expect(await prisma.gameEvent.count()).toBe(2);
    expect(await prisma.purchase.count()).toBe(0);
  });

  it('4-1. 배치 구조가 유효하면 전부 거절이어도 200 (AI_RULES 25)', async () => {
    const res = await post(
      makeBatch([
        makeEvent({ event_type: 'not_a_type' }),
        makeEvent({ event_id: 'not-a-uuid' }),
      ]),
    ).expect(200);
    const body = res.body as BatchResponseBody;

    expect(body.accepted_count).toBe(0);
    expect(body.stored_count).toBe(0);
    expect(body.rejected_count).toBe(2);
    expect(body.rejected.map((r) => r.code)).toEqual([
      'INVALID_ENVELOPE',
      'INVALID_ENVELOPE',
    ]);
    assertInvariants(body);
    expect(await prisma.gameEvent.count()).toBe(0);
  });

  it('5-1. 잘못된 API 키 → 401 UNAUTHORIZED', async () => {
    const res = await post(makeBatch([makeEvent()]), 'wrong-key').expect(401);
    expect(res.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    await request(app.getHttpServer())
      .post(PATH)
      .send(makeBatch([makeEvent()]))
      .expect(401);
  });

  it('5-2. 키-instance_id 불일치 → 403 INSTANCE_MISMATCH, 아무것도 저장되지 않음', async () => {
    const res = await post(
      makeBatch([
        makeEvent(),
        makeEvent({ instance_id: randomUUID() }), // 타 인스턴스 사칭
      ]),
    ).expect(403);
    expect(res.body).toMatchObject({ error: { code: 'INSTANCE_MISMATCH' } });
    expect(await prisma.gameEvent.count()).toBe(0);
  });

  it('5-3. 501건 배치 → 400 MALFORMED_REQUEST', async () => {
    const events = Array.from({ length: 501 }, () => makeEvent());
    const res = await post(makeBatch(events)).expect(400);
    expect(res.body).toMatchObject({ error: { code: 'MALFORMED_REQUEST' } });
    expect(await prisma.gameEvent.count()).toBe(0);
  });

  it('9. [회귀] 대문자 UUID 정규화 — 결제 파생 생성, 대소문자만 다른 재전송은 duplicate', async () => {
    const upperEventId = randomUUID().toUpperCase();

    // 대문자 event_id + 대문자 instance_id (RFC 4122상 유효 — 403이 아니어야 함)
    const first = await post(
      makeBatch([
        makePurchaseEvent('ORDER-CASE-1', {
          event_id: upperEventId,
          instance_id: INSTANCE_ID.toUpperCase(),
        }),
      ]),
    ).expect(200);
    const firstBody = first.body as BatchResponseBody;
    expect(firstBody.stored_count).toBe(1);
    expect(firstBody.order_duplicate_count).toBe(0);
    assertInvariants(firstBody);
    // 리뷰 발견 1 회귀: 대문자 event_id여도 결제 파생 행이 생성되어야 한다
    expect(await prisma.purchase.count()).toBe(1);

    // 같은 UUID를 소문자로만 바꿔 재전송 → duplicate, 행 수 불변
    const second = await post(
      makeBatch([
        makePurchaseEvent('ORDER-CASE-1', {
          event_id: upperEventId.toLowerCase(),
        }),
      ]),
    ).expect(200);
    const body = second.body as BatchResponseBody;
    expect(body.stored_count).toBe(0);
    expect(body.duplicate_count).toBe(1);
    expect(body.order_duplicate_count).toBe(0);
    assertInvariants(body);
    expect(await prisma.gameEvent.count()).toBe(1);
    expect(await prisma.purchase.count()).toBe(1);
  });

  it('10. 시간대 표기 없는 occurred_at → rejected (계약: ISO8601 UTC)', async () => {
    const res = await post(
      makeBatch([makeEvent({ occurred_at: '2026-01-01T10:00:00' })]),
    ).expect(200);
    const body = res.body as BatchResponseBody;
    expect(body.accepted_count).toBe(0);
    expect(body.rejected_count).toBe(1);
    expect(body.rejected[0].code).toBe('INVALID_ENVELOPE');
    assertInvariants(body);
    expect(await prisma.gameEvent.count()).toBe(0);
  });

  it('7. 4MB 초과 본문 → 413 + ErrorResponse 형식', async () => {
    // 4MB(4,194,304 bytes)를 넘도록 4.5MB 문자열 payload를 담는다
    const oversized = makeBatch([
      makeEvent({ payload: { blob: 'x'.repeat(4_500_000) } }),
    ]);
    const res = await post(oversized).expect(413);
    expect(res.body).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) as string },
    });
    expect(await prisma.gameEvent.count()).toBe(0);
  });

  it('[실패 회귀] 비JSON Content-Type도 4MB 하드 제한을 우회할 수 없다', async () => {
    // design.md §2.3은 서버와 프록시 모두 요청 본문에 4MB 하드 제한을
    // 적용한다고 정의한다. express.json()이 건너뛰는 타입도 같은 제한이어야 한다.
    const oversized = 'x'.repeat(4_500_000);

    // supertest의 in-process socket은 서버가 본문을 소비하지 않고 조기 응답하면
    // ECONNRESET이 될 수 있어, 실제 TCP listener에 전송해 응답 코드를 관찰한다.
    await app.listen(0, '127.0.0.1');
    const res = await fetch(`${await app.getUrl()}${PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'text/plain',
      },
      body: oversized,
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) as string },
    });
    expect(await prisma.gameEvent.count()).toBe(0);
  });

  it('8. 500건 최대 배치 → 200 전량 저장, 처리 시간이 구조화 로그에 남음 (design.md §6.5)', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log');
    try {
      const batch = makeBatch(
        Array.from({ length: 500 }, (_, i) =>
          i % 10 === 0
            ? makePurchaseEvent(`ORDER-MAX-${i}`)
            : makeEvent({ event_type: 'monster_kill', payload: { monster_id: `m-${i}` } }),
        ),
      );

      const res = await post(batch).expect(200);
      const body = res.body as BatchResponseBody;

      expect(body.received_count).toBe(500);
      expect(body.stored_count).toBe(500);
      expect(body.duplicate_count).toBe(0);
      expect(body.order_duplicate_count).toBe(0);
      expect(body.rejected_count).toBe(0);
      assertInvariants(body);
      expect(await prisma.gameEvent.count()).toBe(500);
      expect(await prisma.purchase.count()).toBe(50);

      // 배치 처리 시간·카운터 구조화 로그 확인
      const structured = (logSpy.mock.calls as unknown[][])
        .map((args) => args[0])
        .filter((arg): arg is string => typeof arg === 'string')
        .find((msg) => msg.includes('"batch processed"'));
      expect(structured).toBeDefined();
      const parsed = JSON.parse(structured!) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        batch_id: batch.batch_id,
        received: 500,
        stored: 500,
        duration_ms: expect.any(Number) as number,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('6. order_id 충돌이 같은 배치의 다른 이벤트에 영향 없음 (design.md §12.2-9)', async () => {
    const batch = makeBatch([
      makeEvent({ user_id: 1 }),
      makePurchaseEvent('ORDER-9001'),
      makePurchaseEvent('ORDER-9001'), // 같은 배치 내 order_id 충돌 (다른 event_id)
      makeEvent({ event_type: 'map_enter', payload: { to_map_id: 'map-2' } }),
    ]);

    const res = await post(batch).expect(200);
    const body = res.body as BatchResponseBody;

    expect(body.received_count).toBe(4);
    expect(body.accepted_count).toBe(4);
    expect(body.stored_count).toBe(4); // 원본은 4건 모두 저장 — 롤백 없음
    expect(body.duplicate_count).toBe(0);
    expect(body.order_duplicate_count).toBe(1); // 파생만 1건 생략
    expect(body.rejected_count).toBe(0);
    assertInvariants(body);

    expect(await prisma.gameEvent.count()).toBe(4);
    expect(await prisma.purchase.count()).toBe(1);
  });
});
