import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // 기본 body parser(100KB 제한)를 끄고 4MB 제한으로 직접 등록한다.
  // 전송 제약 "요청 본문 최대 4MB"(design.md §2.3)와 일치 — 초과 시 express가 413 반환.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.use(json({ limit: '4mb' }));

  // 전역 DTO 검증 (class-validator / class-transformer)
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
