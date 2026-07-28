import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * 적재 API 인증 가드 (design.md §5.4, AI_RULES 9).
 *
 * 1) Bearer 키 검증 — 누락/무효 시 401 UNAUTHORIZED
 * 2) 키-instance_id 일치 검증 — 배치 내 이벤트의 instance_id가 키에 매핑된
 *    인스턴스와 다르면 403 INSTANCE_MISMATCH (탈취 키로 타 인스턴스 사칭 방지)
 *
 * 과제 구현에서는 단일 인스턴스 키를 환경변수로 주입한다 [A-21]:
 *   INGEST_API_KEY(키) ↔ INGEST_INSTANCE_ID(매핑된 인스턴스)
 *
 * instance_id가 아예 없거나 문자열이 아닌 이벤트는 여기서 403을 내지 않는다 —
 * 그것은 "사칭"이 아니라 "형식 오류"이므로 per-event 검증(INVALID_ENVELOPE)이
 * 200 + rejected로 처리한다 (design.md §5.3).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const expectedKey = this.config.get<string>('INGEST_API_KEY');
    const header = request.headers.authorization;
    if (!expectedKey || !header || !header.startsWith('Bearer ')) {
      throw this.unauthorized();
    }
    const token = header.slice('Bearer '.length);
    if (!safeEquals(token, expectedKey)) {
      throw this.unauthorized();
    }

    // UUID는 대소문자 무관(RFC 4122)이므로 소문자 정규형으로 비교한다
    const mappedInstanceId = this.config
      .get<string>('INGEST_INSTANCE_ID')
      ?.toLowerCase();
    if (mappedInstanceId) {
      const body: unknown = request.body;
      const events =
        typeof body === 'object' && body !== null
          ? (body as { events?: unknown }).events
          : undefined;
      if (Array.isArray(events)) {
        for (const event of events) {
          if (typeof event !== 'object' || event === null) continue;
          const instanceId = (event as { instance_id?: unknown }).instance_id;
          if (
            typeof instanceId === 'string' &&
            instanceId.toLowerCase() !== mappedInstanceId
          ) {
            throw new ForbiddenException({
              error: {
                code: 'INSTANCE_MISMATCH',
                message: 'instance_id in batch does not match the API key',
              },
            });
          }
        }
      }
    }

    return true;
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      error: { code: 'UNAUTHORIZED', message: 'missing or invalid API key' },
    });
  }
}

/** 타이밍 공격을 피하는 문자열 비교 */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
