import { BadRequestException, Injectable } from '@nestjs/common';
import type { MetricsQueryDto } from './dto/metrics-query.dto';
import { MetricsRepository } from './metrics.repository';
import type {
  DauResponse,
  MetricsMeta,
  RetentionResponse,
  RetentionRow,
} from './metrics.types';

const DAY_MS = 86_400_000;
/** 양 끝 포함 최대 366개 일자 [A-19] */
const MAX_RANGE_DAYS = 366;
const DEFAULT_PAGE_SIZE = 31;

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

  /** §9.1 / §10.2 DAU */
  async getDau(query: MetricsQueryDto): Promise<DauResponse> {
    const range = this.parseRange(query);
    const [rows, uniqueUsers] = await Promise.all([
      this.repository.dauByDay(range.start, range.end),
      this.repository.uniqueLoginUsers(range.start, range.end),
    ]);
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

  /** 달력에 존재하는 날짜인지 검증 (2026-02-30 등 롤오버 차단) */
  private parseCalendarDay(value: string, field: 'start' | 'end'): number {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_DATE_RANGE',
          message: `${field} must be a valid calendar date (YYYY-MM-DD)`,
        },
      });
    }
    return Math.floor(parsed.getTime() / DAY_MS);
  }

  private buildMeta(query: MetricsQueryDto, range: ParsedRange): MetricsMeta {
    return {
      start: range.start,
      end: range.end,
      page: query.page ?? 1,
      page_size: query.page_size ?? DEFAULT_PAGE_SIZE,
      total: range.days, // zero-fill 기준 전체 행 수 = 달력 일수
    };
  }

  /** 범위 밖 page는 200 + 빈 data (§10.1) */
  private paginate<T>(rows: T[], query: MetricsQueryDto): T[] {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    return rows.slice((page - 1) * pageSize, page * pageSize);
  }
}

/** Prisma가 DATE 컬럼으로 돌려주는 Date(UTC 자정)를 YYYY-MM-DD로 (AI_RULES 15) */
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
