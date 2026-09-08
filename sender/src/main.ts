/**
 * sender 데몬 엔트리포인트 (design-aws.md §4).
 *
 * 실행: INSTANCE_ID=... API_KEY=... TARGET_URL=http://localhost:3000 \
 *         npx ts-node sender/src/main.ts
 * 선택 env: USERS=30, EVENT_RATE=0.5, SEND_RATE_LIMIT=60, OUTBOX_DIR=sender/outbox-data
 *
 * 종료: SIGTERM/SIGINT — 진행 중 배치의 응답 처리까지 마치고 종료 (systemd 전제).
 * SIGKILL(강제 종료) 후에도 outbox 저널이 미전송분을 보존하며, 재시작 시
 * 체크포인트부터 이어서 전송한다 [A-26].
 */
import { loadConfig } from './config';
import { SenderDaemon } from './daemon';
import { log } from './logger';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const daemon = new SenderDaemon(config);
  daemon.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutdown signal received', { signal });
    daemon
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log('error', 'shutdown failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
