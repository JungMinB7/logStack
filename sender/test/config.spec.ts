import { loadConfig } from '../src/config';

const REQUIRED = {
  INSTANCE_ID: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
  API_KEY: 'test-key',
  TARGET_URL: 'http://localhost:3000/',
};

describe('sender config — env fail-closed', () => {
  it.each(['INSTANCE_ID', 'API_KEY', 'TARGET_URL'] as const)(
    '%s 누락 시 기동을 거부한다',
    (name) => {
      expect(() => loadConfig({ ...REQUIRED, [name]: '' })).toThrow(
        `missing required environment variables: ${name}`,
      );
    },
  );

  it('기본값과 target trailing slash 정규화를 적용한다', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      instanceId: REQUIRED.INSTANCE_ID,
      apiKey: REQUIRED.API_KEY,
      targetUrl: 'http://localhost:3000',
      users: 30,
      eventRate: 0.5,
      sendRateLimit: 60,
      outboxDir: 'sender/outbox-data',
    });
  });

  it('USERS=0/EVENT_RATE=0 drain-only 모드는 허용한다', () => {
    const config = loadConfig({ ...REQUIRED, USERS: '0', EVENT_RATE: '0' });
    expect(config.users).toBe(0);
    expect(config.eventRate).toBe(0);
  });

  it.each([
    ['USERS', '-1'],
    ['USERS', '1.5'],
    ['USERS', '31'],
    ['EVENT_RATE', '-0.1'],
    ['EVENT_RATE', 'NaN'],
    ['SEND_RATE_LIMIT', '0'],
    ['SEND_RATE_LIMIT', '1.5'],
  ])('%s=%s 잘못된 수치는 기본값으로 숨기지 않고 거부한다', (name, value) => {
    expect(() => loadConfig({ ...REQUIRED, [name]: value })).toThrow(name);
  });

  it('유효하지 않은 UUID와 http(s)가 아닌 URL을 거부한다', () => {
    expect(() => loadConfig({ ...REQUIRED, INSTANCE_ID: 'not-a-uuid' })).toThrow(
      'INSTANCE_ID must be a UUID',
    );
    expect(() => loadConfig({ ...REQUIRED, TARGET_URL: 'file:///tmp/x' })).toThrow(
      'TARGET_URL must be an http(s) base URL',
    );
  });
});
