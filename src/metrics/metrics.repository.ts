import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** 트랜잭션 안팎 어디서든 실행할 수 있도록 쿼리 메서드가 받는 클라이언트 타입 */
type Db = Prisma.TransactionClient;

/**
 * 지표 집계 SQL 전담 (AI_RULES 13 — SQL은 *.repository.ts에만).
 *
 * 공통 규칙:
 * - 모든 기간은 반개구간 [start 00:00 UTC, end+1일 00:00 UTC) — AI_RULES 20.
 *   `$d::timestamp AT TIME ZONE 'UTC'`로 세션 시간대와 무관하게 UTC 자정을 만든다
 * - 일자 귀속은 (occurred_at AT TIME ZONE 'UTC')::date — occurred_at 기준 (AI_RULES 2)
 * - zero-fill은 generate_series로 달력 일자를 만들어 LEFT JOIN (AI_RULES 23)
 * - COUNT는 ::int 캐스팅으로 BigInt 반환을 차단 (AI_RULES 15)
 * - data와 summary를 병기하는 지표(dau/revenue/conversion)는 *WithSummary 메서드가
 *   REPEATABLE READ 트랜잭션으로 묶어 한 응답이 단일 DB 스냅샷을 보게 한다
 *   (Codex 회귀: 두 쿼리 사이의 동시 커밋으로 data·summary가 어긋나는 문제)
 */
@Injectable()
export class MetricsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 읽기 전용 스냅샷 트랜잭션 — data·summary 쿼리 묶음용 */
  private snapshot<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  /** §10.2 DAU — 일별 data와 기간 summary를 단일 스냅샷에서 읽는다 */
  async dauWithSummary(
    start: string,
    end: string,
  ): Promise<{
    rows: Array<{ day: Date; dau: number }>;
    uniqueUsers: number;
  }> {
    return this.snapshot(async (tx) => {
      const rows = await this.dauByDay(start, end, tx);
      const uniqueUsers = await this.uniqueLoginUsers(start, end, tx);
      return { rows, uniqueUsers };
    });
  }

  /** §10.4 매출 — 일별 data와 기간 summary(매출·활성 유저)를 단일 스냅샷에서 읽는다 */
  async revenueWithSummary(
    start: string,
    end: string,
    currency: string,
  ): Promise<{
    rows: Array<{ day: Date; revenue_minor: string; active_users: number }>;
    revenueTotal: string;
    activeTotal: number;
  }> {
    return this.snapshot(async (tx) => {
      const rows = await this.revenueByDay(start, end, currency, tx);
      const revenueTotal = await this.revenueTotal(start, end, currency, tx);
      const activeTotal = await this.uniqueLoginUsers(start, end, tx);
      return { rows, revenueTotal, activeTotal };
    });
  }

  /** §10.5 전환율 — 일별 data와 기간 summary를 단일 스냅샷에서 읽는다 */
  async conversionWithSummary(
    start: string,
    end: string,
  ): Promise<{
    rows: Array<{ day: Date; paying_users: number; active_users: number }>;
    totals: { paying_users: number; active_users: number };
  }> {
    return this.snapshot(async (tx) => {
      const rows = await this.conversionByDay(start, end, tx);
      const totals = await this.conversionTotals(start, end, tx);
      return { rows, totals };
    });
  }

  /**
   * §9.1 DAU — 일자별 session_login 고유 user_id 수.
   * §10.2 zero-fill: 요청 기간의 모든 달력 일자를 행으로 반환, date ASC.
   */
  async dauByDay(
    start: string,
    end: string,
    db: Db = this.prisma,
  ): Promise<Array<{ day: Date; dau: number }>> {
    return db.$queryRaw<Array<{ day: Date; dau: number }>>(Prisma.sql`
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
  async uniqueLoginUsers(
    start: string,
    end: string,
    db: Db = this.prisma,
  ): Promise<number> {
    const rows = await db.$queryRaw<Array<{ unique_users: number }>>(
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

  /**
   * §9.3 일별 매출/활성 유저 — 매출 = SUM(amount_minor).
   * amount_minor는 주문 총액이므로 quantity를 다시 곱하지 않는다 [A-28].
   * 통화별 분리 집계(currency 필터) — 통화 간 합산 금지 (AI_RULES 5).
   * revenue_minor는 ::text 캐스팅으로 반환 — SUM(bigint)는 numeric이라 합계가
   * signed BIGINT 범위를 넘을 수 있으므로 ::bigint로 되캐스팅하지 않는다
   * (Codex 회귀: 안전 정수 1,025건 합계 오버플로우).
   */
  async revenueByDay(
    start: string,
    end: string,
    currency: string,
    db: Db = this.prisma,
  ): Promise<Array<{ day: Date; revenue_minor: string; active_users: number }>> {
    return db.$queryRaw(Prisma.sql`
      WITH days AS (
        SELECT generate_series(${start}::date, ${end}::date, interval '1 day')::date AS day
      ),
      daily_active AS (
        -- §9.1: 일별 활성 유저 (ARPU 분모 — ARPPU 아님, AI_RULES 7)
        SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
               COUNT(DISTINCT user_id)::int AS active_users
        FROM game_events
        WHERE event_type = 'session_login'
          AND occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
          AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
        GROUP BY 1
      ),
      daily_revenue AS (
        -- §9.3: 일별 매출 합계 (반개구간, occurred_at 기준). SUM(bigint)→numeric 유지
        SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
               SUM(amount_minor) AS revenue_minor
        FROM purchases
        WHERE currency = ${currency}
          AND occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
          AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
        GROUP BY 1
      )
      SELECT d.day AS day,
             COALESCE(r.revenue_minor, 0)::text AS revenue_minor,
             COALESCE(a.active_users, 0)        AS active_users
      FROM days d
      LEFT JOIN daily_revenue r ON r.day = d.day
      LEFT JOIN daily_active a  ON a.day = d.day
      ORDER BY d.day ASC
    `);
  }

  /**
   * §9.3 summary — 기간 전체 매출 합계 (통화 필터, 반개구간).
   * ::text 반환 — BIGINT 합계 오버플로우 방지 (revenueByDay와 동일한 이유)
   */
  async revenueTotal(
    start: string,
    end: string,
    currency: string,
    db: Db = this.prisma,
  ): Promise<string> {
    const rows = await db.$queryRaw<
      Array<{ revenue_minor: string }>
    >(Prisma.sql`
      SELECT COALESCE(SUM(amount_minor), 0)::text AS revenue_minor
      FROM purchases
      WHERE currency = ${currency}
        AND occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
        AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
    `);
    return rows[0]?.revenue_minor ?? '0';
  }

  /**
   * §9.4 일별 결제 전환율 재료 — 분자는 단순 결제 유저 수가 아니라
   * |결제 유저 ∩ 같은 일자 활성 유저| (LEFT JOIN 후 COUNT(p.user_id) = 교집합).
   * 전일 로그인 + 당일 결제(자정 걸친 세션) 유저는 당일 분자에서 제외되어
   * 0~1 범위가 구조적으로 보장된다. amount_minor=0 결제도 포함 [A-29].
   */
  async conversionByDay(
    start: string,
    end: string,
    db: Db = this.prisma,
  ): Promise<Array<{ day: Date; paying_users: number; active_users: number }>> {
    return db.$queryRaw(Prisma.sql`
      WITH days AS (
        SELECT generate_series(${start}::date, ${end}::date, interval '1 day')::date AS day
      ),
      daily_active AS (
        SELECT DISTINCT (occurred_at AT TIME ZONE 'UTC')::date AS day, user_id
        FROM game_events
        WHERE event_type = 'session_login'
          AND occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
          AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
      ),
      daily_paying AS (
        -- amount_minor 조건 없음: 0원 결제(무료 프로모션)도 PU 포함 [A-29]
        SELECT DISTINCT (occurred_at AT TIME ZONE 'UTC')::date AS day, user_id
        FROM purchases
        WHERE occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
          AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
      ),
      counts AS (
        -- 분자 = 활성 유저 집합과의 교집합 (활성 유저 기준 LEFT JOIN이므로
        -- 활성이 아닌 결제 유저는 집계되지 않는다)
        SELECT a.day,
               COUNT(*)::int AS active_users,
               COUNT(p.user_id)::int AS paying_users
        FROM daily_active a
        LEFT JOIN daily_paying p ON p.day = a.day AND p.user_id = a.user_id
        GROUP BY a.day
      )
      SELECT d.day AS day,
             COALESCE(c.paying_users, 0) AS paying_users,
             COALESCE(c.active_users, 0) AS active_users
      FROM days d
      LEFT JOIN counts c ON c.day = d.day
      ORDER BY d.day ASC
    `);
  }

  /**
   * §9.4 summary — 기간 전체 고유 유저로 재계산 (일별 비율의 평균 금지, AI_RULES 8).
   * 분자는 EXISTS로 "기간 내 로그인한 적 있는 결제 유저"만 센다 (교집합).
   */
  async conversionTotals(
    start: string,
    end: string,
    db: Db = this.prisma,
  ): Promise<{ paying_users: number; active_users: number }> {
    const rows = await db.$queryRaw<
      Array<{ paying_users: number; active_users: number }>
    >(Prisma.sql`
      SELECT
        (SELECT COUNT(DISTINCT user_id)::int
         FROM game_events
         WHERE event_type = 'session_login'
           AND occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
           AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
        ) AS active_users,
        (SELECT COUNT(DISTINCT p.user_id)::int
         FROM purchases p
         WHERE p.occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
           AND p.occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
           AND EXISTS (
             SELECT 1 FROM game_events g
             WHERE g.event_type = 'session_login'
               AND g.user_id = p.user_id
               AND g.occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
               AND g.occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
           )
        ) AS paying_users
    `);
    return rows[0] ?? { paying_users: 0, active_users: 0 };
  }

  /**
   * §9.5 활동별 참여율 재료 — (일 × event_type) zero-fill 격자.
   * 분자는 단순 발생 유저 수가 아니라 |발생 유저 ∩ 같은 일자 DAU 집합|:
   * daily_active(로그인 유저) 기준 INNER JOIN이므로 로그인 없는 유저의 활동은
   * 분자에서 제외되어 0~1 범위가 구조적으로 보장된다 (§9.4와 동일한 자정 케이스 대응).
   * 발생 건수가 아닌 고유 유저 기준 — 헤비 유저 반복 행동에 왜곡되지 않음 (§9.5).
   */
  async engagementByDayType(
    start: string,
    end: string,
    eventTypes: string[],
  ): Promise<
    Array<{ day: Date; event_type: string; engaged_users: number; dau: number }>
  > {
    return this.prisma.$queryRaw(Prisma.sql`
      WITH days AS (
        SELECT generate_series(${start}::date, ${end}::date, interval '1 day')::date AS day
      ),
      types AS (
        -- zero-fill의 두 번째 축: 요청된 event_type 목록 (생략 시 13개 전체)
        SELECT unnest(ARRAY[${Prisma.join(eventTypes)}])::varchar AS event_type
      ),
      daily_active AS (
        -- §9.1: 해당 일자 DAU 집합 (분모이자 교집합의 기준 집합)
        SELECT DISTINCT (occurred_at AT TIME ZONE 'UTC')::date AS day, user_id
        FROM game_events
        WHERE event_type = 'session_login'
          AND occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
          AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
      ),
      daily_dau AS (
        SELECT day, COUNT(*)::int AS dau FROM daily_active GROUP BY day
      ),
      engaged AS (
        -- 해당 일자에 event_type을 1회 이상 발생시킨 고유 유저
        SELECT DISTINCT (occurred_at AT TIME ZONE 'UTC')::date AS day,
               event_type, user_id
        FROM game_events
        WHERE event_type IN (${Prisma.join(eventTypes)})
          AND occurred_at >= ${start}::timestamp AT TIME ZONE 'UTC'
          AND occurred_at < ((${end}::date + 1)::timestamp AT TIME ZONE 'UTC')
      ),
      counts AS (
        -- 분자 = 발생 유저 ∩ DAU 집합 (INNER JOIN = 교집합)
        SELECT e.day, e.event_type, COUNT(*)::int AS engaged_users
        FROM engaged e
        JOIN daily_active a ON a.day = e.day AND a.user_id = e.user_id
        GROUP BY e.day, e.event_type
      )
      SELECT d.day AS day,
             t.event_type,
             COALESCE(c.engaged_users, 0) AS engaged_users,
             COALESCE(u.dau, 0)           AS dau
      FROM days d
      CROSS JOIN types t
      LEFT JOIN counts c ON c.day = d.day AND c.event_type = t.event_type
      LEFT JOIN daily_dau u ON u.day = d.day
      ORDER BY d.day ASC, t.event_type ASC
    `);
  }
}
