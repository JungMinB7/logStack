import { BadRequestException } from '@nestjs/common';
import { isRetryableStorageError } from './http-exception.filter';

/**
 * 재시도 가능 오류 → 503 매핑의 가벼운 단위 검증.
 * (커넥션 풀 압력을 실제로 만드는 동시 e2e는 flaky 위험이 있어 두지 않고,
 * 만료 경로는 metrics e2e의 "스냅샷 트랜잭션 만료" 테스트가 담당한다)
 */
describe('isRetryableStorageError (P2028/P1001/P1002 → 503 매핑 판별)', () => {
  it('P2028(트랜잭션 만료·커넥션 획득 실패)을 재시도 가능으로 판별한다', () => {
    const error = Object.assign(new Error('Transaction already closed'), {
      code: 'P2028',
    });
    expect(isRetryableStorageError(error)).toBe(true);
  });

  it.each(['P1001', 'P1002'])(
    '%s(DB 연결 오류, errorCode 형태)를 재시도 가능으로 판별한다',
    (errorCode) => {
      const error = Object.assign(new Error("Can't reach database server"), {
        errorCode,
      });
      expect(isRetryableStorageError(error)).toBe(true);
    },
  );

  it('그 외 Prisma 오류(P2002 등)·일반 예외·HttpException은 매핑하지 않는다', () => {
    expect(
      isRetryableStorageError(
        Object.assign(new Error('unique violation'), { code: 'P2002' }),
      ),
    ).toBe(false);
    expect(isRetryableStorageError(new Error('boom'))).toBe(false);
    expect(isRetryableStorageError(new BadRequestException())).toBe(false);
    expect(isRetryableStorageError(null)).toBe(false);
    expect(isRetryableStorageError('P2028')).toBe(false);
  });
});
