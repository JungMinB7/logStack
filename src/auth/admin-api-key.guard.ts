import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { safeEquals } from './safe-equals';

/**
 * 조회(지표) API 인증 가드 (design.md §10.1, AI_RULES 9).
 * ADMIN_API_KEY(Bearer) 검증 — 적재 키(INGEST_API_KEY)와 별개의 키이며,
 * 적재 키로 지표를 조회할 수 없다. 누락/무효 시 401.
 * (키는 fail-closed 부팅 검증으로 항상 존재한다 — env.validation.ts)
 */
@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expectedKey = this.config.get<string>('ADMIN_API_KEY');
    const header = request.headers.authorization;
    if (!expectedKey || !header || !header.startsWith('Bearer ')) {
      throw this.unauthorized();
    }
    if (!safeEquals(header.slice('Bearer '.length), expectedKey)) {
      throw this.unauthorized();
    }
    return true;
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      error: { code: 'UNAUTHORIZED', message: 'missing or invalid API key' },
    });
  }
}
