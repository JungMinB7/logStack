import { BadRequestException, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { validateEnv } from './common/env.validation';
import { HttpErrorFilter } from './common/filters/http-exception.filter';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { firstConstraintMessage } from './common/validation.util';
import { DatabaseModule } from './database/database.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    // fail-closed: 필수 키(INGEST_API_KEY, INGEST_INSTANCE_ID, ADMIN_API_KEY)
    // 미설정 시 부팅 실패 (src/common/env.validation.ts)
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    AuthModule,
    CommonModule,
    IngestionModule,
    MetricsModule,
  ],
  providers: [
    // 서버 내부 하드 데드라인 10초 (design.md §6.4)
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    // 에러 응답을 openapi ErrorResponse 형식으로 통일
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    // 전역 DTO 검증 — "배치 구조" 실패는 400 MALFORMED_REQUEST (design.md §5.5).
    // 개별 이벤트 검증은 이 파이프가 아니라 IngestionService가 수행한다 (200 + rejected).
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          transform: true,
          whitelist: true,
          exceptionFactory: (errors) =>
            new BadRequestException({
              error: {
                code: 'MALFORMED_REQUEST',
                message: firstConstraintMessage(errors),
              },
            }),
        }),
    },
  ],
})
export class AppModule {}
