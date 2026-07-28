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

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

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
