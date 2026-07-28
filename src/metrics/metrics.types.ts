/** 시계열 공통 meta (docs/api.openapi.yaml — Meta). total = zero-fill 기준 전체 행 수 */
export interface MetricsMeta {
  start: string;
  end: string;
  page: number;
  page_size: number;
  total: number;
}

export interface DauResponse {
  meta: MetricsMeta;
  summary: {
    /** 기간 전체 고유 로그인 유저 수 (일별 합이 아님 — design.md §10.2) */
    unique_users: number;
  };
  data: Array<{ date: string; dau: number }>;
}

export interface RetentionRow {
  cohort_date: string;
  new_users: number;
  /** 미성숙 또는 new_users=0이면 null, 성숙했지만 미복귀면 0 (design.md §9.2) */
  d1: number | null;
  d7: number | null;
  d30: number | null;
  matured: { d1: boolean; d7: boolean; d30: boolean };
}

export interface RetentionResponse {
  meta: MetricsMeta;
  data: RetentionRow[];
}

export interface RevenueRow {
  date: string;
  currency: string;
  /** BIGINT 정밀도 보존을 위한 문자열 (AI_RULES 15) */
  revenue_minor: string;
  active_users: number;
  /** 소수 2자리 문자열 (정수 연산 후 포맷). 활성 유저 0이면 null */
  arpu_minor: string | null;
}

export interface RevenueResponse {
  meta: MetricsMeta;
  /** 기간 전체 기준 — active_users는 기간 고유 유저 (일별 합 아님, §9.3) */
  summary: {
    currency: string;
    revenue_minor: string;
    active_users: number;
    arpu_minor: string | null;
  };
  data: RevenueRow[];
}

export interface ConversionRow {
  date: string;
  /** |결제 유저 ∩ 활성 유저| (§9.4 교집합 정의) */
  paying_users: number;
  active_users: number;
  /** 소수 4자리. 활성 유저 0이면 null */
  conversion_rate: number | null;
}

export interface ConversionResponse {
  meta: MetricsMeta;
  /** 기간 전체 고유 유저로 재계산 (일별 비율의 평균이 아님 — AI_RULES 8) */
  summary: {
    paying_users: number;
    active_users: number;
    conversion_rate: number | null;
  };
  data: ConversionRow[];
}
