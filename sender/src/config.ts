/**
 * sender 설정 — env 기반, 필수값 누락 시 기동 거부 (fail-closed).
 * 서버(env.validation.ts)와 같은 원칙: 키 없이 조용히 무의미하게 돌지 않는다.
 */
export interface SenderConfig {
  /** 이 전송 인스턴스의 ID — 모든 이벤트의 instance_id (키와 매핑) */
  instanceId: string;
  /** 적재 API Bearer 키 */
  apiKey: string;
  /** 수신 서버 베이스 URL (예: http://localhost:3000) */
  targetUrl: string;
  /** 가상 유저 수 (기본 30 — 인스턴스 만석 [A-4]) */
  users: number;
  /** 유저당 평균 이벤트 생성률 (건/초, 기본 0.5 [A-5]) */
  eventRate: number;
  /** 자체 스로틀 — 분당 전송 요청 상한 (기본 60 = 서버 한도 120의 50%, §2.1) */
  sendRateLimit: number;
  /** outbox 저널 디렉토리 */
  outboxDir: string;
}

const REQUIRED = ['INSTANCE_ID', 'API_KEY', 'TARGET_URL'] as const;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): SenderConfig {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `missing required environment variables: ${missing.join(', ')} — ` +
      'sender refuses to start (fail-closed)',
    );
  }
  const instanceId = env.INSTANCE_ID!.trim();
  if (!UUID_PATTERN.test(instanceId)) {
    throw new Error('INSTANCE_ID must be a UUID');
  }
  const targetUrl = parseTargetUrl(env.TARGET_URL!.trim());
  return {
    instanceId,
    apiKey: env.API_KEY!.trim(),
    targetUrl,
    // 0은 통합 검증·운영 복구의 drain-only 모드에 사용한다.
    users: optionalNumber(env.USERS, 30, 'USERS', true, 0, 30),
    eventRate: optionalNumber(env.EVENT_RATE, 0.5, 'EVENT_RATE', false),
    sendRateLimit: optionalNumber(
      env.SEND_RATE_LIMIT,
      60,
      'SEND_RATE_LIMIT',
      true,
      1,
    ),
    outboxDir: env.OUTBOX_DIR?.trim() || 'sender/outbox-data',
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseTargetUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('TARGET_URL must be a valid http(s) URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'TARGET_URL must be an http(s) base URL without credentials, query, or fragment',
    );
  }
  return raw.replace(/\/+$/, '');
}

function optionalNumber(
  raw: string | undefined,
  fallback: number,
  name: string,
  integer: boolean,
  minimum = 0,
  maximum = Infinity,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed) ||
    (integer && !Number.isInteger(parsed)) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    const kind = integer ? 'integer' : 'number';
    const range = Number.isFinite(maximum)
      ? `between ${minimum} and ${maximum}`
      : `>= ${minimum}`;
    throw new Error(`${name} must be a ${kind} ${range}`);
  }
  return parsed;
}
