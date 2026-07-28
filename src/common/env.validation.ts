/**
 * 환경변수 fail-closed 검증 (ConfigModule.forRoot의 validate 훅).
 *
 * 인증 키가 미설정된 채 부팅되면 가드가 검증을 건너뛰는(fail-open) 상태가 되므로,
 * 필수 변수가 하나라도 없으면 부팅 자체를 실패시킨다.
 * 어떤 변수가 빠졌는지 에러 메시지에 명시한다.
 */
export const REQUIRED_ENV_VARS = [
  'INGEST_API_KEY',
  'INGEST_INSTANCE_ID',
  'ADMIN_API_KEY',
] as const;

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const missing = REQUIRED_ENV_VARS.filter((name) => {
    const value = config[name];
    if (value === undefined || value === null) return true;
    // 공백만 있는 값(" ")도 누락으로 간주 — 인증이 무의미한 키로 부팅되는 것 방지
    return typeof value === 'string' && value.trim() === '';
  });
  if (missing.length > 0) {
    throw new Error(
      `missing required environment variables: ${missing.join(', ')} — ` +
        'set them in the environment or .env (see .env.example)',
    );
  }
  return config;
}
