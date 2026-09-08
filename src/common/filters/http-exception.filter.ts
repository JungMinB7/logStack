import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * 모든 에러 응답을 openapi의 ErrorResponse 형식({ error: { code, message } })으로
 * 통일하는 전역 필터.
 *
 * - 예외가 이미 { error: ... } 본문을 담고 있으면 그대로 내보낸다
 *   (가드·서비스가 코드별 본문을 직접 지정하는 경우)
 * - 그 외 HttpException은 상태 코드별 기본 code/message로 변환한다
 * - 알 수 없는 예외는 500 INTERNAL_ERROR (상세 내용은 로그로만 남기고 반사하지 않음)
 */
const CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'MALFORMED_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'INSTANCE_MISMATCH',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'STORAGE_UNAVAILABLE',
};

const MESSAGE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'request is malformed',
  [HttpStatus.UNAUTHORIZED]: 'missing or invalid API key',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'resource not found',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'request body exceeds 4MB limit',
  [HttpStatus.TOO_MANY_REQUESTS]: 'too many requests',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'temporary storage failure, retry later',
};

/** 소켓 수준 연결 실패 코드 — DB 프로세스 다운·네트워크 단절류 */
const RETRYABLE_SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

/**
 * 재시도 가능한 저장소 오류인지 판별 (오류 코드 duck-typing —
 * ORM 타입을 repository 밖으로 가져오지 않기 위해 코드 문자열만 본다).
 *
 * TypeORM/pg 세계의 재시도 가능 오류 (ADR-005 전환 후 실제 발생 경로):
 * - PG 57014 (query_canceled): statement_timeout 5초·트랜잭션 예산 8초 초과 —
 *   구 Prisma P2028(트랜잭션 만료)의 등가물. QueryFailedError는 driverError의
 *   속성을 자신에게 복사하므로 code/driverError.code 양쪽을 본다
 * - PG 08xxx (connection_exception 클래스): 연결 예외
 * - ECONNREFUSED 등 소켓 오류: DB 서버 접속 불가 (구 P1001/P1002 등가물)
 * - 커넥션 풀 획득 timeout (pg: "timeout exceeded when trying to connect")
 *
 * 구 Prisma 코드(P2028/P1001/P1002) 판별은 하위 호환으로 유지한다
 * (이 매핑을 잠근 기존 단위 테스트가 무수정 원칙의 대상이기 때문).
 * 이들은 클라이언트가 재시도하면 성공할 수 있으므로 500이 아니라
 * 503 STORAGE_UNAVAILABLE로 응답한다 (design.md §5.5, §6.4).
 */
export function isRetryableStorageError(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const candidate = exception as {
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
    driverError?: { code?: unknown } | null;
  };
  const codes = [
    candidate.code,
    candidate.errorCode,
    candidate.driverError?.code,
  ].filter((value): value is string => typeof value === 'string');

  for (const code of codes) {
    if (code === '57014') return true; // query_canceled (statement_timeout)
    if (code.startsWith('08')) return true; // connection_exception 클래스
    if (RETRYABLE_SOCKET_CODES.has(code)) return true;
    if (code === 'P2028' || code === 'P1001' || code === 'P1002') return true;
  }
  // pg-pool 커넥션 획득 timeout은 코드 없이 메시지로만 구분된다
  return (
    typeof candidate.message === 'string' &&
    candidate.message.includes('timeout exceeded when trying to connect')
  );
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (isRetryableStorageError(exception)) {
      this.logger.warn(
        `retryable storage error: ${exception instanceof Error ? exception.message : String(exception)}`,
      );
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: {
          code: 'STORAGE_UNAVAILABLE',
          message: 'temporary storage failure, retry later',
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        response.status(status).json(body);
        return;
      }
      response.status(status).json({
        error: {
          code: CODE_BY_STATUS[status] ?? 'ERROR',
          message: MESSAGE_BY_STATUS[status] ?? 'request failed',
        },
      });
      return;
    }

    this.logger.error(
      'unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL_ERROR', message: 'unexpected server error' },
    });
  }
}
