import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { RateLimitStore } from './rate-limit.store';

/** 서버 측 한도 기본값 — 과제 전송 제약 120회/분 (env RATE_LIMIT_PER_MINUTE로 조정) */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

/**
 * 적재 경로 전용 rate limit 가드 (design.md §5.5의 429 계약, design-aws.md §5).
 *
 * 실행 순서: 컨트롤러의 @UseGuards(ApiKeyGuard, RateLimitGuard) 선언 순서대로
 * 실행된다(NestJS 가드 실행 규칙) — 인증(401/403)을 통과한 요청만 카운트하므로
 * 무효 키 연타는 429 카운터를 소모하지 않는다.
 *
 * 지표 조회 경로에는 적용하지 않는다 — 120회/분은 게임 서버(전송측) 제약이며,
 * 서버 429는 자체 스로틀(60req/분)이 무너졌을 때의 최후 방어선이다 (AI_RULES 32).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly store: RateLimitStore,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // ApiKeyGuard 통과 후이므로 Authorization 헤더는 항상 "Bearer <유효 키>"다.
    // 카운터 키를 제시된 키 문자열로 잡아 키(=인스턴스) 단위 창을 만든다 [A-25]
    const apiKey = (request.headers.authorization ?? '').slice(
      'Bearer '.length,
    );

    const result = this.store.consume(apiKey, this.limitPerMinute());
    if (result.allowed) {
      return true;
    }

    const response = context.switchToHttp().getResponse<Response>();
    // 창 리셋까지 남은 초 (최소 1) — 전송측은 이 값 + jitter만큼 대기한다 (§4.2)
    response.setHeader('Retry-After', String(result.retryAfterSec));

    // 관측용 구조화 로그 (§6.5, T8 시나리오 C 재료).
    // 키 원문은 시크릿이라 로그에 남기지 않고 해시 지문만 기록한다 (AI_RULES 29)
    this.logger.warn(
      JSON.stringify({
        msg: 'rate limited',
        key_fingerprint: fingerprint(apiKey),
        window_count: result.count,
        limit_per_minute: this.limitPerMinute(),
        retry_after_s: result.retryAfterSec,
      }),
    );

    // 전역 필터가 { error: ... } 본문을 그대로 통과시킨다 (ErrorResponse 형식)
    throw new HttpException(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'too many requests, retry after the window resets',
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** env RATE_LIMIT_PER_MINUTE — 미설정·비정상 값이면 기본 120 */
  private limitPerMinute(): number {
    const raw = this.config.get<string>('RATE_LIMIT_PER_MINUTE');
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return DEFAULT_RATE_LIMIT_PER_MINUTE;
    }
    return parsed;
  }
}

/** 로그용 키 지문 — 원문 복원 불가(sha256 앞 8자) */
function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
