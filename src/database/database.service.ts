import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { STATEMENT_TIMEOUT_MS } from './data-source';

/**
 * DB 유틸 서비스 — 두 가지 역할만 갖는다.
 *
 * 1) 부팅 검증: statement_timeout(5초, data-source.ts의 연결 옵션)이 실제로
 *    적용됐는지 current_setting으로 확인 로그를 남긴다 (design.md §6.4).
 * 2) E2E 테스트의 DB 상태 검증 표면(count·deleteMany·합산): 테스트 단언의
 *    기대값·호출부를 바꾸지 않도록 구 Prisma client와 같은 호출 형태
 *    (gameEvent.count() 등)를 유지한다. 프로덕션 코드 경로는 이 서비스를
 *    쓰지 않고 *.repository.ts가 DataSource를 직접 주입받는다 (AI_RULES 12·13).
 */
@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.dataSource.query<
      Array<{ statement_timeout: string }>
    >(`SELECT current_setting('statement_timeout') AS statement_timeout`);
    const applied = rows[0]?.statement_timeout;
    this.logger.log(
      `DB statement_timeout = ${applied} (기대값 ${STATEMENT_TIMEOUT_MS}ms)`,
    );
    // PG는 5000(ms)을 '5s'로 표시한다 — 두 표기 모두 정상으로 인정
    if (applied !== '5s' && applied !== `${STATEMENT_TIMEOUT_MS}ms`) {
      this.logger.warn(
        `statement_timeout이 기대값(${STATEMENT_TIMEOUT_MS}ms)과 다릅니다: ${applied}`,
      );
    }
  }

  /** 테스트 검증 표면: game_events의 행 수·전체 삭제 */
  readonly gameEvent = {
    count: async (): Promise<number> => {
      const rows = await this.dataSource.query<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM game_events`,
      );
      return rows[0].count;
    },
    deleteMany: async (): Promise<void> => {
      await this.dataSource.query(`DELETE FROM game_events`);
    },
  };

  /** 테스트 검증 표면: purchases의 행 수·전체 삭제·금액 합산 */
  readonly purchase = {
    count: async (): Promise<number> => {
      const rows = await this.dataSource.query<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM purchases`,
      );
      return rows[0].count;
    },
    deleteMany: async (): Promise<void> => {
      await this.dataSource.query(`DELETE FROM purchases`);
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 테스트 단언 형태(_sum.amountMinor) 유지용 시그니처
    aggregate: async (_args: {
      _sum: { amountMinor: true };
    }): Promise<{ _sum: { amountMinor: bigint | null } }> => {
      // 합계는 ::text로 받아 BigInt로 변환 — pg는 bigint를 문자열로 반환한다 (AI_RULES 15)
      const rows = await this.dataSource.query<
        Array<{ sum: string | null }>
      >(`SELECT SUM(amount_minor)::text AS sum FROM purchases`);
      const sum = rows[0]?.sum;
      return { _sum: { amountMinor: sum == null ? null : BigInt(sum) } };
    },
  };
}
