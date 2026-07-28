import type { INestApplication } from '@nestjs/common';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';

/** 전송 제약 "요청 본문 최대 4MB" (design.md §2.3) */
export const JSON_BODY_LIMIT = '4mb';

/**
 * main.ts와 E2E 테스트가 공유하는 HTTP 계층 설정.
 * (전역 파이프·필터·인터셉터는 AppModule의 APP_* 프로바이더로 등록되어 있음)
 *
 * body-parser 에러는 Nest 라우팅에 도달하기 전에 발생하므로 전역 예외 필터가
 * 잡지 못한다. json() 바로 뒤에 express 에러 미들웨어를 두어
 * openapi의 ErrorResponse 형식으로 변환한다:
 * - 4MB 초과(entity.too.large) → 413 PAYLOAD_TOO_LARGE
 * - JSON 파싱 실패 등 그 외 body-parser 에러 → 400 MALFORMED_REQUEST
 */
export function configureApp(app: INestApplication): void {
  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(bodyParserErrorHandler);
}

interface BodyParserError {
  /** body-parser(http-errors)가 부여하는 에러 종류 (예. entity.too.large) */
  type?: unknown;
  status?: unknown;
  statusCode?: unknown;
}

function bodyParserErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const candidate = err as BodyParserError | null;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.type === 'string'
  ) {
    const status =
      typeof candidate.status === 'number'
        ? candidate.status
        : typeof candidate.statusCode === 'number'
          ? candidate.statusCode
          : 400;
    if (status === 413) {
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'request body exceeds 4MB limit',
        },
      });
      return;
    }
    res.status(status).json({
      error: {
        code: 'MALFORMED_REQUEST',
        message: 'request body could not be parsed as JSON',
      },
    });
    return;
  }
  next(err);
}
