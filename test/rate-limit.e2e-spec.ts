// 적재 경로 rate limit E2E — 429 + Retry-After (design.md §5.5, design-aws.md §5).
// 전제: PostgreSQL 실행 중 (docker compose up -d db)
//
// 시간 제어는 기존 리텐션 matured 테스트와 같은 Date.now 스파이 패턴을 쓴다.
// 각 테스트는 서로 다른 1분 창(고정 창)에 시간을 고정해 카운터를 격리한다.

// ConfigService는 process.env를 우선 조회하므로 AppModule 로드 전에 고정한다.
process.env.INGEST_API_KEY ??= 'test-ingest-key';
process.env.INGEST_INSTANCE_ID ??= '0fab3f2e-1894-41cd-b915-f99440a3ff32';
process.env.ADMIN_API_KEY ??= 'test-admin-key';
// 테스트용 소형 한도 — env 설정 가능성(RATE_LIMIT_PER_MINUTE) 검증 겸용.
// afterAll에서 반드시 지운다 (--runInBand는 process.env를 스위트 간 공유하므로
// 남겨두면 이후 스위트의 대량 적재 테스트가 429에 걸린다)
process.env.RATE_LIMIT_PER_MINUTE = '5';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { RateLimitStore } from '../src/auth/rate-limit.store';
import { DatabaseService } from '../src/database/database.service';

const API_KEY = 'test-ingest-key';
const INSTANCE_ID = '0fab3f2e-1894-41cd-b915-f99440a3ff32';
const PATH = '/api/v1/event-batches';
const LIMIT = 5; // process.env.RATE_LIMIT_PER_MINUTE와 동일해야 한다

/** 테스트별로 서로 다른 고정 1분 창을 쓰기 위한 기준 시각 (창 시작점에 정렬) */
const BASE_WINDOW_MS = Date.parse('2049-05-01T00:00:00.000Z');

function makeBatch(): Record<string, unknown> {
  return {
    batch_id: randomUUID(),
    sent_at: '2049-05-01T00:00:00.000Z',
    events: [
      {
        instance_id: INSTANCE_ID,
        event_id: randomUUID(),
        event_type: 'session_login',
        user_id: 42,
        character_id: 142,
        session_id: 'session-rate-limit',
        channel_id: 'channel-01',
        payload: {},
        occurred_at: '2049-05-01T00:00:00.000Z',
      },
    ],
  };
}

describe('Ingestion rate limit (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let store: RateLimitStore;
  let nowSpy: jest.SpyInstance<number, []> | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    db = app.get(DatabaseService);
    store = app.get(RateLimitStore);
  });

  afterAll(async () => {
    // 다음 스위트로의 한도 누수 방지 (--runInBand 공유 process.env)
    delete process.env.RATE_LIMIT_PER_MINUTE;
    await app.close();
  });

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = undefined;
  });

  /** 시간을 windowIndex번째 1분 창의 시작점에 고정한다 */
  function freezeAtWindow(windowIndex: number): void {
    nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(BASE_WINDOW_MS + windowIndex * 10 * 60_000);
  }

  function post(key: string = API_KEY): request.Test {
    return request(app.getHttpServer())
      .post(PATH)
      .set('Authorization', `Bearer ${key}`)
      .send(makeBatch());
  }

  it('한도 내 요청은 전부 200, 한도+1번째는 429 + Retry-After + ErrorResponse', async () => {
    freezeAtWindow(1);

    for (let i = 0; i < LIMIT; i += 1) {
      await post().expect(200);
    }

    const res = await post().expect(429);
    expect(res.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: expect.any(String) as string,
      },
    });
    // 창 시작점에 시간이 고정돼 있으므로 리셋까지 남은 초 = 60 (결정적)
    expect(res.headers['retry-after']).toBe('60');
  });

  it('429로 거절된 요청은 어떤 이벤트도 저장하지 않는다 (행 수 불변)', async () => {
    freezeAtWindow(2);

    for (let i = 0; i < LIMIT; i += 1) {
      await post().expect(200);
    }
    const before = await db.gameEvent.count();

    await post().expect(429);
    await post().expect(429); // 연속 초과도 동일

    expect(await db.gameEvent.count()).toBe(before);
  });

  it('창 경과 후에는 200으로 복귀한다 (고정 1분 창 리셋)', async () => {
    freezeAtWindow(3);
    for (let i = 0; i < LIMIT; i += 1) {
      await post().expect(200);
    }
    await post().expect(429);

    // 61초 뒤 = 다음 창 → 카운터 리셋
    nowSpy?.mockReturnValue(BASE_WINDOW_MS + 3 * 10 * 60_000 + 61_000);
    await post().expect(200);
  });

  it('서로 다른 키는 카운터가 독립이다', () => {
    // 서버에 유효한 적재 키는 1개뿐이라(A-21) 두 번째 키를 HTTP로 통과시킬 수
    // 없으므로(무효 키는 401로 가드에 도달 못 함), 가드가 쓰는 스토어 컴포넌트를
    // DI에서 꺼내 키별 창 독립성을 직접 검증한다.
    freezeAtWindow(4);

    for (let i = 0; i < LIMIT; i += 1) {
      expect(store.consume('key-a', LIMIT).allowed).toBe(true);
    }
    const rejected = store.consume('key-a', LIMIT);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSec).toBeGreaterThanOrEqual(1);

    // key-a가 소진돼도 key-b는 새 카운터로 허용된다
    const other = store.consume('key-b', LIMIT);
    expect(other.allowed).toBe(true);
    expect(other.count).toBe(1);
  });

  it('무효 키 연타는 401만 반환하고 429 카운터를 소모하지 않는다', async () => {
    freezeAtWindow(5);

    // 한도를 훌쩍 넘는 횟수의 무효 키 요청 — 전부 401 (인증이 rate limit보다 먼저)
    for (let i = 0; i < LIMIT + 3; i += 1) {
      const res = await post('wrong-key').expect(401);
      expect(res.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }

    // 유효 키의 창은 소모되지 않았다 — 한도만큼 전부 200, 그 다음이 429
    for (let i = 0; i < LIMIT; i += 1) {
      await post().expect(200);
    }
    await post().expect(429);
  });
});
