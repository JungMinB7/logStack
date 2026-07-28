import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  // 기본 body parser(100KB 제한)를 끄고 configureApp에서 4MB 제한으로 직접 등록한다
  // (design.md §2.3 — 초과 시 413 PAYLOAD_TOO_LARGE, ErrorResponse 형식).
  // 전역 ValidationPipe·예외 필터·타임아웃 인터셉터는 AppModule의
  // APP_PIPE / APP_FILTER / APP_INTERCEPTOR로 등록되어 테스트와 동일하게 동작한다.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureApp(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
