import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * PrismaService를 전역 제공한다.
 * Repository(*.repository.ts)만 PrismaService를 주입받는다 (AI_RULES 12·13).
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
