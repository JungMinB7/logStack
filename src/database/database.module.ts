import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createDataSourceOptions } from './data-source';
import { DatabaseService } from './database.service';

/**
 * TypeORM DataSource를 전역 제공한다.
 * - 설정은 data-source.ts 단일 정의를 앱과 CLI가 공유한다
 * - Repository(*.repository.ts)만 DataSource를 주입받아 SQL을 실행한다 (AI_RULES 12·13)
 * - DatabaseService는 부팅 검증 로그 + E2E 테스트의 DB 상태 검증 표면이다
 */
@Global()
@Module({
  imports: [
    // useFactory로 지연 생성 — ConfigModule(.env 로드)이 먼저 초기화된 뒤 실행된다
    TypeOrmModule.forRootAsync({ useFactory: createDataSourceOptions }),
  ],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
