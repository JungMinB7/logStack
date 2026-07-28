import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * DB statement_timeout 5초 (design.md §6.4).
 * timeout된 쿼리가 DB에서 계속 실행되어 재시도 요청과 중첩되는 것을 방지한다.
 * 서버 내부 하드 데드라인 10초는 TimeoutInterceptor가 담당한다.
 */
export const STATEMENT_TIMEOUT_MS = 5_000;

/**
 * DATABASE_URL에 PostgreSQL 세션 옵션(statement_timeout)을 강제로 부여한다.
 * 환경변수 설정에 의존하지 않고 코드가 보장하도록 여기서 부여한다.
 */
function withStatementTimeout(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  // Prisma postgresql 커넥터의 `options` 파라미터 = 서버 접속 시 command-line options
  url.searchParams.set('options', `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`);
  return url.toString();
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    super(
      databaseUrl
        ? { datasources: { db: { url: withStatementTimeout(databaseUrl) } } }
        : undefined,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
