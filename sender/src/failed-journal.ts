import { closeSync, openSync, readSync } from 'node:fs';

/** Bounded streaming scan: one 64 KiB block + one JSON line, never the whole journal. */
export function* failedJournalIds(
  path: string,
  end = Infinity,
): Generator<{ id: string; offset: number }> {
  const fd = openSync(path, 'r'); // read errors must propagate, not mean “absent”
  const block = Buffer.alloc(64 * 1024);
  let position = 0;
  let lineStart = 0;
  let partial = Buffer.alloc(0);
  try {
    while (position < end) {
      const length = readSync(fd, block, 0, Math.min(block.length, end - position), position);
      if (length === 0) break;
      position += length;
      const data = Buffer.concat([partial, block.subarray(0, length)]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        const record = JSON.parse(data.subarray(start, newline).toString('utf8')) as {
          event?: { event_id?: unknown };
        } | null;
        if (!record || typeof record.event?.event_id !== 'string') {
          throw new Error('failed journal contains invalid JSON');
        }
        yield { id: record.event.event_id, offset: lineStart };
        lineStart += newline - start + 1;
        start = newline + 1;
      }
      partial = Buffer.from(data.subarray(start));
    }
    if (partial.length !== 0) throw new Error('failed journal contains incomplete line');
  } finally {
    closeSync(fd);
  }
}
