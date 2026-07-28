import type { INestApplication } from '@nestjs/common';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';

/** 전송 제약 "요청 본문 최대 4MB" (design.md §2.3) */
export const JSON_BODY_LIMIT = '4mb';
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * main.ts와 E2E 테스트가 공유하는 HTTP 계층 설정.
 * (전역 파이프·필터·인터셉터는 AppModule의 APP_* 프로바이더로 등록되어 있음)
 *
 * 1) Content-Length 검사: 4MB 하드 제한은 Content-Type과 무관하다 —
 *    express.json()이 건너뛰는 비JSON 타입으로 제한을 우회하지 못하게
 *    길이 헤더를 먼저 검사한다 (Codex 회귀). Content-Length 없는
 *    Transfer-Encoding: chunked는 프록시 책임으로 남긴다 (design.md §16).
 * 2) body-parser 에러는 Nest 라우팅에 도달하기 전에 발생하므로 전역 예외
 *    필터가 잡지 못한다. json() 바로 뒤의 에러 미들웨어가 openapi의
 *    ErrorResponse 형식으로 변환한다:
 *    - 4MB 초과(entity.too.large) → 413 PAYLOAD_TOO_LARGE
 *    - JSON 파싱 실패 등 그 외 body-parser 에러 → 400 MALFORMED_REQUEST
 */
export function configureApp(app: INestApplication): void {
  app.use(contentLengthLimit);
  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(bodyParserErrorHandler);
}

/** 413 응답 전에 버리며 읽어줄 본문의 상한 (한도의 2배) — 초과 시 소켓 절단 */
const DRAIN_LIMIT_BYTES = MAX_BODY_BYTES * 2;

function contentLengthLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    // 본문 수신이 끝나기 전에 응답을 보내고 소켓을 닫으면, 업로드 중인
    // 클라이언트가 RST(ECONNRESET)를 받아 413 본문을 읽지 못할 수 있다
    // (Codex fix 검증). 본문을 버리며 끝까지 읽은 뒤 응답하고,
    // keep-alive 재사용은 차단한다. 단, 한도의 2배를 넘는 폭주 업로드는
    // 자원 보호를 위해 소켓을 절단한다.
    const respond = (): void => {
      if (res.headersSent) return;
      res.set('Connection', 'close');
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'request body exceeds 4MB limit',
        },
      });
    };
    let drained = 0;
    req.on('data', (chunk: Buffer) => {
      drained += chunk.length;
      if (drained > DRAIN_LIMIT_BYTES) {
        respond();
        req.destroy();
      }
    });
    req.on('end', respond);
    req.on('error', () => {
      // 클라이언트가 중간에 끊은 경우 — 응답 불가, 조용히 종료
    });
    return;
  }
  next();
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
