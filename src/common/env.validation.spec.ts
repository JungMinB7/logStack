import { validateEnv } from './env.validation';

const VALID = {
  INGEST_API_KEY: 'k1',
  INGEST_INSTANCE_ID: 'i1',
  ADMIN_API_KEY: 'k2',
};

describe('validateEnv (fail-closed)', () => {
  it('필수 변수가 모두 있으면 config를 그대로 반환한다', () => {
    expect(validateEnv({ ...VALID })).toEqual(VALID);
  });

  it.each(['INGEST_API_KEY', 'INGEST_INSTANCE_ID', 'ADMIN_API_KEY'])(
    '%s 누락 시 변수명을 명시하며 throw 한다',
    (name) => {
      const config: Record<string, unknown> = { ...VALID };
      delete config[name];
      expect(() => validateEnv(config)).toThrow(name);
    },
  );

  it('빈 문자열도 누락으로 취급한다', () => {
    expect(() => validateEnv({ ...VALID, ADMIN_API_KEY: '' })).toThrow(
      'ADMIN_API_KEY',
    );
  });

  it('공백만 있는 문자열(" ")도 누락으로 취급한다', () => {
    expect(() => validateEnv({ ...VALID, INGEST_API_KEY: '   ' })).toThrow(
      'INGEST_API_KEY',
    );
  });

  it('[Codex 회귀] 적재 키와 관리자 키가 같으면 역할 분리를 위해 부팅을 거부한다', () => {
    expect(() =>
      validateEnv({
        INGEST_API_KEY: 'shared-key',
        INGEST_INSTANCE_ID: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
        ADMIN_API_KEY: 'shared-key',
      }),
    ).toThrow(/INGEST_API_KEY.*ADMIN_API_KEY|ADMIN_API_KEY.*INGEST_API_KEY/);
  });
});
