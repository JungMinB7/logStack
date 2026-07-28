import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { from, lastValueFrom } from 'rxjs';
import {
  REQUEST_DEADLINE_MS,
  TimeoutInterceptor,
} from './timeout.interceptor';

describe('TimeoutInterceptor', () => {
  it('[실패 회귀] 503 deadline 이후 underlying 저장 작업이 계속 실행되지 않는다', async () => {
    jest.useFakeTimers();
    let writeCompleted = false;
    const next: CallHandler = {
      handle: () =>
        from(
          new Promise<string>((resolve) => {
            setTimeout(() => {
              writeCompleted = true;
              resolve('committed');
            }, REQUEST_DEADLINE_MS + 1_000);
          }),
        ),
    };
    const interceptor = new TimeoutInterceptor();

    try {
      const result = lastValueFrom(
        interceptor.intercept({} as ExecutionContext, next),
      );
      const rejection = expect(result).rejects.toMatchObject({
        status: 503,
      });

      await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
      await rejection;
      await jest.advanceTimersByTimeAsync(1_000);

      // AI_RULES 26: deadline 초과 시 롤백 후 503이어야 한다.
      // 단순 Observable unsubscribe만으로 Promise는 취소되지 않아 현재는 true가 된다.
      expect(writeCompleted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
