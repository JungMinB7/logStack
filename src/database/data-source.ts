import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { types } from 'pg';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { GameEvent } from './entities/game-event.entity';
import { Purchase } from './entities/purchase.entity';
import { Init1757310000000 } from './migrations/1757310000000-Init';

/**
 * DB statement_timeout 5초 (design.md §6.4).
 * timeout된 쿼리가 DB에서 계속 실행되어 재시도 요청과 중첩되는 것을 방지한다.
 * 구 Prisma의 DATABASE_URL `options` 파라미터 방식을 pg 연결 옵션으로 대체했다.
 * 서버 내부 하드 데드라인 10초는 TimeoutInterceptor가 담당한다.
 */
export const STATEMENT_TIMEOUT_MS = 5_000;

/** 트랜잭션 전체 상한 8초 (design.md §6.4) — 각 repository가 SET LOCAL 예산으로 강제 */
export const TRANSACTION_TIMEOUT_MS = 8_000;

/**
 * pg 드라이버의 DATE(oid 1082) 기본 파서는 로컬 자정 Date를 만들기 때문에
 * KST 등 UTC가 아닌 환경에서 toISOString() 기반 일자 변환이 하루 어긋난다.
 * Prisma와 동일하게 "UTC 자정 Date"로 파싱해 Service 계층(toDateString)이
 * 변경 없이 동작하게 한다 (AI_RULES 3 — 일자 경계는 UTC).
 */
types.setTypeParser(types.builtins.DATE, (value: string) =>
  new Date(`${value}T00:00:00.000Z`),
);

/**
 * TypeORM CLI(migration:run)는 .env를 읽지 않으므로(구 Prisma CLI는 자동 로드),
 * DATABASE_URL이 없을 때만 프로젝트 루트 .env에서 최소한으로 보충한다.
 */
function loadDatabaseUrlFromDotEnv(): string | undefined {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return match[1].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/**
 * 앱(TypeOrmModule.forRootAsync)과 CLI가 공유하는 단일 DataSource 설정.
 * synchronize: false 고정 — 스키마의 원천은 migrations/의 raw SQL이다.
 */
export function createDataSourceOptions(): DataSourceOptions {
  const url = process.env.DATABASE_URL ?? loadDatabaseUrlFromDotEnv();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set — set it in the environment or .env (see .env.example)',
    );
  }
  return {
    type: 'postgres',
    url,
    entities: [GameEvent, Purchase],
    migrations: [Init1757310000000],
    synchronize: false,
    extra: {
      // 모든 풀 커넥션에 statement_timeout 5초를 강제 (환경변수 설정에 의존하지 않음)
      options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      // 커넥션 획득 대기 상한 — 구 Prisma $transaction maxWait(5초)와 동일 체계.
      // 초과 시 재시도 가능한 저장소 오류로 503 매핑된다 (http-exception.filter)
      connectionTimeoutMillis: 5_000,
    },
  };
}

/** TypeORM CLI 전용 진입점: npx typeorm migration:run -d <이 파일> */
export default new DataSource(createDataSourceOptions());
