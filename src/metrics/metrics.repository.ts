import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 지표 집계 SQL 전담 (AI_RULES 13 — SQL은 *.repository.ts에만).
 *
 * 공통 규칙:
 * - 모든 기간은 반개구간 [start 00:00 UTC, end+1일 00:00 UTC) — AI_RULES 20.
 *   `$d::timestamp AT TIME ZONE 'UTC'`로 세션 시간대와 무관하게 UTC 자정을 만든다
 * - 일자 귀속은 (occurred_at AT TIME ZONE 'UTC')::date — occurred_at 기준 (AI_RULES 2)
 * - zero-fill은 generate_series로 달력 일자를 만들어 LEFT JOIN (AI_RULES 23)
 * - COUNT는 ::int 캐스팅으로 BigInt 반환을 차단 (AI_RULES 15)
 */
@Injectable()
export class MetricsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * §9.1 DAU — 일자별 session_login 고유 user_id 수.
   * §10.2 zero-fill: 요청 기간의 모든 달력 일자를 행으로 반환, date ASC.
   */
  async dauByDay(
    start: string,
    end: string,
  ): Promise<Array<{ day: Date; dau: number }>> {
    return this.prisma.$queryRaw<Array<{ day: Date; dau: number }>>(Prisma.sql`
      WITH days AS (
        -- zero-fill 기준이 되는 달력 일자 (start ~ end, 양 끝 포함)
        SELECT generate_series(${start}::date, ${end}::date, interval '1 day')::date AS day
      ),
      daily_logins AS (
        -- §9.1: 하루 여러 번 로그인해도 1명 (DISTINCT day, user_id)
        -- 반개구간 [start, end+1일)
        SELECT DISTINCT (occurred_at AT TIME ZONE 'UTC')::date AS day, user_id
        FROM game_events
        WHERE event_type = 'session_login'
          AND occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
          AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
      )
      SELECT d.day AS day, COUNT(l.user_id)::int AS dau
      FROM days d
      LEFT JOIN daily_logins l ON l.day = d.day
      GROUP BY d.day
      ORDER BY d.day ASC
    `);
  }

  /**
   * §10.2 summary.unique_users — 기간 전체의 고유 로그인 유저 수.
   * 일별 DISTINCT의 합으로는 복원할 수 없으므로 별도 쿼리로 계산한다.
   */
  async uniqueLoginUsers(start: string, end: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ unique_users: number }>>(
      Prisma.sql`
        SELECT COUNT(DISTINCT user_id)::int AS unique_users
        FROM game_events
        WHERE event_type = 'session_login'
          AND occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
          AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
      `,
    );
    return rows[0]?.unique_users ?? 0;
  }

  /**
   * §9.2 리텐션 — 코호트 일자별 신규 유저 수와 D1/D7/D30 복귀 유저 수.
   * 비율·matured·null 판정은 Service가 수행한다 (날짜 판단은 업무 규칙).
   */
  async retentionByCohort(
    start: string,
    end: string,
  ): Promise<
    Array<{
      cohort_date: Date;
      new_users: number;
      returned_d1: number;
      returned_d7: number;
      returned_d30: number;
    }>
  > {
    return this.prisma.$queryRaw(Prisma.sql`
      WITH days AS (
        -- zero-fill: 신규 유저가 없는 코호트 일자도 행으로 반환 (§10.3)
        SELECT generate_series(${start}::date, ${end}::date, interval '1 day')::date AS day
      ),
      first_login AS (
        -- §9.2 계산 순서 1: 최초 로그인은 조회 범위 필터 없이
        -- 전체 이력에서 user_id별 MIN(occurred_at) — 기간으로 먼저 자르면
        -- 기존 유저가 신규로 오분류된다 [A-32]
        SELECT user_id, MIN(occurred_at) AS first_at
        FROM game_events
        WHERE event_type = 'session_login'
        GROUP BY user_id
      ),
      cohort AS (
        -- §9.2 계산 순서 2: 최초 로그인 일자가 start~end에 속하는 코호트만 선택
        -- (start/end는 코호트 일자를 필터하는 파라미터)
        SELECT user_id, (first_at AT TIME ZONE 'UTC')::date AS cohort_date
        FROM first_login
        WHERE first_at >= ${start}::timestamp AT TIME ZONE 'UTC'
          AND first_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
      ),
      login_days AS (
        -- §9.2 계산 순서 3: Dn 판정용 로그인 일자 집합.
        -- 의도적으로 기간 필터가 없다 — 1/31 코호트의 D30은 3/2 전후
        -- 데이터가 필요하므로 요청 end 밖 데이터도 조회한다
        SELECT DISTINCT user_id, (occurred_at AT TIME ZONE 'UTC')::date AS day
        FROM game_events
        WHERE event_type = 'session_login'
      ),
      per_cohort AS (
        -- Dn = 코호트일 + 정확히 n일 하루(exact-day)에 로그인한 유저 수 [A-15]
        SELECT c.cohort_date,
               COUNT(*)::int AS new_users,
               COUNT(l1.user_id)::int  AS returned_d1,
               COUNT(l7.user_id)::int  AS returned_d7,
               COUNT(l30.user_id)::int AS returned_d30
        FROM cohort c
        LEFT JOIN login_days l1
          ON l1.user_id = c.user_id AND l1.day = c.cohort_date + 1
        LEFT JOIN login_days l7
          ON l7.user_id = c.user_id AND l7.day = c.cohort_date + 7
        LEFT JOIN login_days l30
          ON l30.user_id = c.user_id AND l30.day = c.cohort_date + 30
        GROUP BY c.cohort_date
      )
      SELECT d.day AS cohort_date,
             COALESCE(p.new_users, 0)    AS new_users,
             COALESCE(p.returned_d1, 0)  AS returned_d1,
             COALESCE(p.returned_d7, 0)  AS returned_d7,
             COALESCE(p.returned_d30, 0) AS returned_d30
      FROM days d
      LEFT JOIN per_cohort p ON p.cohort_date = d.day
      ORDER BY d.day ASC
    `);
  }
}
