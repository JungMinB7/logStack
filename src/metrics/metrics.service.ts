import { BadRequestException, Injectable } from '@nestjs/common';
import { EVENT_TYPES } from '../ingestion/dto/event-envelope.dto';
import type { EngagementQueryDto } from './dto/engagement-query.dto';
import type { MetricsQueryDto } from './dto/metrics-query.dto';
import type { RevenueQueryDto } from './dto/revenue-query.dto';
import { MetricsRepository } from './metrics.repository';
import type {
  ConversionResponse,
  DauResponse,
  EngagementResponse,
  MetricsMeta,
  RetentionResponse,
  RetentionRow,
  RevenueResponse,
} from './metrics.types';

const DAY_MS = 86_400_000;
/** 양 끝 포함 최대 366개 일자 [A-19] */
const MAX_RANGE_DAYS = 366;
const DEFAULT_PAGE_SIZE = 31;
/** 지원 날짜 범위: 1970-01-01 ~ 9999-12-31 (PostgreSQL date와의 교집합) */
const MIN_DATE_MS = Date.UTC(1970, 0, 1);
const MAX_DATE_MS = Date.UTC(9999, 11, 31);

interface ParsedRange {
  start: string;
  end: string;
  /** 양 끝 포함 일수 = zero-fill 행 수 = meta.total */
  days: number;
  /** epoch 기준 일 수 (UTC) — matured 판정용 */
  startDay: number;
}

/**
 * 지표 업무 규칙 (design.md §9, §10.1).
 * - 기간·페이지 의미 검증 (INVALID_DATE_RANGE / RANGE_TOO_LARGE)
 * - 비율 반올림(소수 5자리에서 반올림해 4자리), null 정책, matured 판정
 * - 페이지네이션은 zero-fill된 전체 행에 대해 수행, meta.total은 전체 행 수
 */
@Injectable()
export class MetricsService {
  constructor(private readonly repository: MetricsRepository) {}

  /** §9.1 / §10.2 DAU — data·summary는 단일 스냅샷 (Codex 회귀) */
  async getDau(query: MetricsQueryDto): Promise<DauResponse> {
    const range = this.parseRange(query);
    const { rows, uniqueUsers } = await this.repository.dauWithSummary(
      range.start,
      range.end,
    );
    const data = rows.map((row) => ({
      date: toDateString(row.day),
      dau: row.dau,
    }));
    return {
      meta: this.buildMeta(query, range),
      // summary는 페이지네이션과 무관하게 기간 전체 기준 (AI_RULES 23)
      summary: { unique_users: uniqueUsers },
      data: this.paginate(data, query),
    };
  }

  /** §9.2 / §10.3 리텐션 (D1/D7/D30, exact-day) */
  async getRetention(query: MetricsQueryDto): Promise<RetentionResponse> {
    const range = this.parseRange(query);
    const rows = await this.repository.retentionByCohort(range.start, range.end);

    // §9.2 matured: 현재 UTC 일자 > 코호트 일자 + n일 때만 true —
    // 관찰 일자가 완전히 끝나기 전에는 불완전한 값 대신 null을 반환 [A-16]
    const todayDay = Math.floor(Date.now() / DAY_MS);

    const data: RetentionRow[] = rows.map((row) => {
      const cohortDate = toDateString(row.cohort_date);
      const cohortDay = toEpochDay(cohortDate);
      const rate = (n: number, returned: number): number | null => {
        const matured = todayDay > cohortDay + n;
        // 값 구분: 미성숙 → null / new_users=0(zero-fill) → null /
        // 성숙했지만 아무도 안 돌아옴 → 0.0 (숫자)
        if (!matured || row.new_users === 0) return null;
        return round4(returned / row.new_users);
      };
      return {
        cohort_date: cohortDate,
        new_users: row.new_users,
        d1: rate(1, row.returned_d1),
        d7: rate(7, row.returned_d7),
        d30: rate(30, row.returned_d30),
        matured: {
          d1: todayDay > cohortDay + 1,
          d7: todayDay > cohortDay + 7,
          d30: todayDay > cohortDay + 30,
        },
      };
    });

    return {
      meta: this.buildMeta(query, range),
      data: this.paginate(data, query),
    };
  }

  /** §9.3 / §10.4 매출·ARPU (통화별 분리, 일별 data + 기간 summary 병기, 단일 스냅샷) */
  async getRevenue(query: RevenueQueryDto): Promise<RevenueResponse> {
    const currency = this.parseCurrency(query.currency);
    const range = this.parseRange(query);
    const { rows, revenueTotal, activeTotal } =
      await this.repository.revenueWithSummary(range.start, range.end, currency);
    const data = rows.map((row) => ({
      date: toDateString(row.day),
      currency,
      // DB가 ::text로 돌려준 십진 문자열을 그대로 전달 (BIGINT 합계 오버플로우 안전)
      revenue_minor: row.revenue_minor,
      active_users: row.active_users,
      arpu_minor: formatArpuMinor(BigInt(row.revenue_minor), row.active_users),
    }));
    return {
      meta: this.buildMeta(query, range),
      // §9.3: 기간 ARPU = 기간 전체 매출 ÷ 기간 고유 활성 유저 (일별 합 아님)
      summary: {
        currency,
        revenue_minor: revenueTotal,
        active_users: activeTotal,
        arpu_minor: formatArpuMinor(BigInt(revenueTotal), activeTotal),
      },
      data: this.paginate(data, query),
    };
  }

  /** §9.4 / §10.5 결제 전환율 (분자 = 활성 유저 집합과의 교집합, 단일 스냅샷) */
  async getPurchaseConversion(
    query: MetricsQueryDto,
  ): Promise<ConversionResponse> {
    const range = this.parseRange(query);
    const { rows, totals } = await this.repository.conversionWithSummary(
      range.start,
      range.end,
    );
    const data = rows.map((row) => ({
      date: toDateString(row.day),
      paying_users: row.paying_users,
      active_users: row.active_users,
      conversion_rate: rate(row.paying_users, row.active_users),
    }));
    return {
      meta: this.buildMeta(query, range),
      // §9.4: 월(기간) 전환율은 일별 비율의 평균이 아니라 기간 고유 유저로 재계산
      summary: {
        paying_users: totals.paying_users,
        active_users: totals.active_users,
        conversion_rate: rate(totals.paying_users, totals.active_users),
      },
      data: this.paginate(data, query),
    };
  }

  /** §9.5 / §10.6 [제안 지표] 활동별 참여율 — 일별 grain만 (summary 없음) */
  async getEngagement(query: EngagementQueryDto): Promise<EngagementResponse> {
    const eventTypes = this.parseEventTypes(query.event_type);
    const range = this.parseRange(query);
    const rows = await this.repository.engagementByDayType(
      range.start,
      range.end,
      eventTypes,
    );
    const data = rows.map((row) => ({
      date: toDateString(row.day),
      event_type: row.event_type,
      engaged_users: row.engaged_users,
      dau: row.dau,
      engagement_rate: rate(row.engaged_users, row.dau), // DAU 0이면 null
    }));
    return {
      // total = 달력 일수 × 타입 수 — 생략 시 최대 366×13으로 페이지네이션이
      // 실질 필요한 유일한 endpoint (§10.6)
      meta: this.buildMeta(query, range, range.days * eventTypes.length),
      data: this.paginate(data, query),
    };
  }

  /** event_type 허용 목록 검증 — 목록 밖 값은 400 UNKNOWN_EVENT_TYPE (§10.6) */
  private parseEventTypes(value: string | undefined): string[] {
    if (value === undefined) return [...EVENT_TYPES]; // 생략 시 13개 타입 전체
    if (!(EVENT_TYPES as readonly string[]).includes(value)) {
      throw new BadRequestException({
        error: {
          code: 'UNKNOWN_EVENT_TYPE',
          message: 'event_type must be one of the 13 defined event types',
        },
      });
    }
    return [value];
  }

  /** currency 필수 + ISO 4217 형식 — 오류는 400 INVALID_CURRENCY (§10.4) */
  private parseCurrency(value: string | undefined): string {
    if (!value || !/^[A-Z]{3}$/.test(value)) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_CURRENCY',
          message: 'currency is required and must be an ISO 4217 code (e.g. KRW)',
        },
      });
    }
    return value;
  }

  /** §10.1 기간 검증 — 실패는 400 + 통일 에러 형식 (AI_RULES 11) */
  private parseRange(query: MetricsQueryDto): ParsedRange {
    const startDay = this.parseCalendarDay(query.start, 'start');
    const endDay = this.parseCalendarDay(query.end, 'end');
    if (startDay > endDay) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_DATE_RANGE',
          message: 'start must be less than or equal to end',
        },
      });
    }
    const days = endDay - startDay + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException({
        error: {
          code: 'RANGE_TOO_LARGE',
          message: `date range must be at most ${MAX_RANGE_DAYS} days`,
        },
      });
    }
    return { start: query.start, end: query.end, days, startDay };
  }

  /**
   * 달력에 존재하는 날짜인지 검증 (2026-02-30 등 롤오버 차단).
   * 지원 범위는 1970-01-01 ~ 9999-12-31 — JS Date는 year 0000을 허용하지만
   * PostgreSQL에는 존재하지 않는 연도라 DB 오류(500)로 새는 것을 차단한다.
   */
  private parseCalendarDay(value: string, field: 'start' | 'end'): number {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value ||
      parsed.getTime() < MIN_DATE_MS ||
      parsed.getTime() > MAX_DATE_MS
    ) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_DATE_RANGE',
          message: `${field} must be a valid calendar date between 1970-01-01 and 9999-12-31`,
        },
      });
    }
    return Math.floor(parsed.getTime() / DAY_MS);
  }

  private buildMeta(
    query: MetricsQueryDto,
    range: ParsedRange,
    total: number = range.days, // 기본: zero-fill 기준 전체 행 수 = 달력 일수
  ): MetricsMeta {
    return {
      start: range.start,
      end: range.end,
      page: query.page ?? 1,
      page_size: query.page_size ?? DEFAULT_PAGE_SIZE,
      total,
    };
  }

  /** 범위 밖 page는 200 + 빈 data (§10.1) */
  private paginate<T>(rows: T[], query: MetricsQueryDto): T[] {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    return rows.slice((page - 1) * pageSize, page * pageSize);
  }
}

/** DATE 컬럼의 Date(UTC 자정 — data-source.ts의 pg 파서 설정)를 YYYY-MM-DD로 (AI_RULES 15) */
function toDateString(day: Date): string {
  return day.toISOString().slice(0, 10);
}

function toEpochDay(dateString: string): number {
  return Math.floor(new Date(`${dateString}T00:00:00.000Z`).getTime() / DAY_MS);
}

/** 비율 반올림 규칙: 소수 5자리에서 반올림해 4자리 (design.md §9 공통, AI_RULES 24) */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 비율 = 분자/분모 (소수 4자리), 분모 0이면 null */
function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return round4(numerator / denominator);
}

/**
 * ARPU = 매출 ÷ 활성 유저 — 소수 3자리에서 반올림해 2자리 문자열 (AI_RULES 24).
 * 부동소수점을 쓰지 않는다: BigInt 정수 연산으로 센트(소수 2자리) 단위를
 * 반올림한 뒤 문자열로 포맷한다. 활성 유저 0이면 null [A-18].
 */
function formatArpuMinor(
  revenueMinor: bigint,
  activeUsers: number,
): string | null {
  if (activeUsers === 0) return null;
  const users = BigInt(activeUsers);
  const numerator = revenueMinor * 100n; // 소수 2자리(센트) 스케일
  const quotient = numerator / users;
  const remainder = numerator % users;
  const cents = quotient + (remainder * 2n >= users ? 1n : 0n); // 반올림(half-up)
  const intPart = cents / 100n;
  const fracPart = (cents % 100n).toString().padStart(2, '0');
  return `${intPart.toString()}.${fracPart}`;
}
