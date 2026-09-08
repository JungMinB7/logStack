import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Observable, TimeoutError, catchError, throwError, timeout } from 'rxjs';

/**
 * 서버 내부 하드 데드라인 (design.md §6.4).
 *
 * 전송측 요청 timeout(30초)보다 훨씬 짧은 10초를 서버 내부 상한으로 두어,
 * 전송측이 timeout으로 재시도한 요청과 아직 서버에서 처리 중인 요청이
 * 중첩되는 것을 방지한다. DB 계층은 별도로 statement_timeout 5초를 적용한다
 * (src/database/data-source.ts 참조). 초과 시 503 — 전송측 재시도 대상 (STORAGE_UNAVAILABLE).
 */
export const REQUEST_DEADLINE_MS = 10_000;

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(REQUEST_DEADLINE_MS),
      catchError((err: unknown) => {
        if (err instanceof TimeoutError) {
          return throwError(
            () =>
              new ServiceUnavailableException({
                error: {
                  code: 'STORAGE_UNAVAILABLE',
                  message: 'request exceeded server deadline, retry later',
                },
              }),
          );
        }
        return throwError(() => err);
      }),
    );
  }
}
