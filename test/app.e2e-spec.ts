// 필수 환경변수(fail-closed) — .env가 없어도 테스트가 자립하도록 기본값 부여
process.env.INGEST_API_KEY ??= 'test-ingest-key';
process.env.INGEST_INSTANCE_ID ??= '0fab3f2e-1894-41cd-b915-f99440a3ff32';
process.env.ADMIN_API_KEY ??= 'test-admin-key';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

// E2E 전제: PostgreSQL이 떠 있어야 한다 (docker compose up -d db).
// PrismaService가 부팅 시 $connect 하기 때문이다.
// 전역 파이프·필터·인터셉터는 AppModule의 APP_* 프로바이더로 함께 로드된다.

describe('App scaffold (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health → 200 { status: "ok" }', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
