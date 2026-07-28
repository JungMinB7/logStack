import { Controller, Get } from '@nestjs/common';

/**
 * 컨테이너/배포 환경의 liveness 확인용. 인증 없이 접근 가능.
 * (DB 연결 확인이 필요한 readiness는 이후 작업에서 필요 시 분리)
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
