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
