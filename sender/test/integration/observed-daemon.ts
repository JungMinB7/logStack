/** Test-only entry: observe successful durable appends independently of receiver/ACK. */
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config';
import { SenderDaemon } from '../../src/daemon';

const config = loadConfig();
// Sender constructs/opens its outbox before any generation starts.
const daemon = new SenderDaemon(config, fetch, {
  onRecorded(events) {
    const bytes = Buffer.from(events.map((event) => event.event_id).join('\n') + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(ledgerFd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error('expected ledger short write');
      offset += count;
    }
    fsyncSync(ledgerFd); // An observer error fails this test process; never fabricate G.
  },
});
const ledgerFd = openSync(join(config.outboxDir, 'recorded-ids.txt'), 'a');
fsyncSync(ledgerFd);
const directoryFd = openSync(config.outboxDir, 'r');
fsyncSync(directoryFd);
closeSync(directoryFd);
daemon.start();
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void daemon.stop().then(() => {
    closeSync(ledgerFd);
    process.exit(0);
  }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
