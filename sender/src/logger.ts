/**
 * 구조화 로그 — CloudWatch Logs 수집 전제의 JSON 라인 (design-aws.md §9).
 * 시크릿(API 키 원문)은 어떤 필드에도 넣지 않는다 (AI_RULES 29).
 */
export type LogLevel = 'info' | 'warn' | 'error';

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`,
  );
}
