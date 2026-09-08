import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventInput } from '../../scripts/send-events';
import { FAILED_ID_CACHE_LIMIT, Outbox } from '../src/outbox';

const event = (id: number): EventInput => ({
  instance_id: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
  event_id: String(id), event_type: 'monster_kill', user_id: 1,
  character_id: 1, session_id: 'test', channel_id: 'test', payload: {},
  occurred_at: '2026-09-08T00:00:00.000Z',
});

describe('bounded failed ID cache with exact durable fallback', () => {
  let dir: string;
  let outbox: Outbox | undefined;
  beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'sender-cache-')); });
  afterEach(() => {
    jest.restoreAllMocks();
    outbox?.close();
    outbox = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses default 100,000 and validates a configurable test boundary', () => {
    expect(FAILED_ID_CACHE_LIMIT).toBe(100_000);
    expect(() => Outbox.open(dir, -1)).toThrow('invalid failed ID cache limit');
  });

  it.each([0, 2])('never exceeds cap %i, including overflow and restart', (cap) => {
    outbox = Outbox.open(dir, cap);
    expect(outbox.quarantine([event(1), event(2), event(3)], 'test')).toBe(3);
    expect(outbox.cachedFailedIdCount).toBe(cap);
    expect(outbox.quarantine([event(3), event(4), event(4)], 'test')).toBe(1);
    expect(outbox.failedCount).toBe(4);
    outbox.close();
    outbox = Outbox.open(dir, cap);
    expect(outbox.cachedFailedIdCount).toBe(cap);
    expect(outbox.failedCount).toBe(4);
    expect(outbox.quarantine([event(3), event(4)], 'test')).toBe(0);
    expect(fs.readFileSync(join(dir, 'failed.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('startup and fallback stream rather than whole-file read, and count old duplicates exactly', () => {
    outbox = Outbox.open(dir, 1);
    outbox.quarantine([event(1), event(2), event(3)], 'test');
    outbox.close();
    const failedPath = join(dir, 'failed.jsonl');
    const line = fs.readFileSync(failedPath, 'utf8').trim().split('\n')[2];
    fs.appendFileSync(failedPath, `${line}\n`);
    const original = fs.readFileSync;
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === failedPath) throw new Error('whole failed journal read forbidden');
      return original(...args);
    });
    outbox = Outbox.open(dir, 1);
    expect(outbox.failedCount).toBe(3);
    expect(outbox.quarantine([event(3)], 'test')).toBe(0);
    read.mockRestore();
  });

  it('fallback read failure cannot mean absent or advance checkpoint', () => {
    outbox = Outbox.open(dir, 1);
    outbox.appendMany([event(2)]);
    outbox.quarantine([event(1), event(2)], 'test');
    const checkpoint = fs.readFileSync(join(dir, 'checkpoint.json'), 'utf8');
    const read = jest.spyOn(fs, 'readSync').mockImplementation(() => { throw new Error('read EIO'); });
    expect(() => outbox!.quarantine([event(2)], 'test')).toThrow('read EIO');
    read.mockRestore();
    expect(fs.readFileSync(join(dir, 'checkpoint.json'), 'utf8')).toBe(checkpoint);
    expect(outbox.pendingCount).toBe(1);
    expect(outbox.quarantine([event(2)], 'test')).toBe(0);
  });

  it('startup read failure refuses open', () => {
    outbox = Outbox.open(dir, 1);
    outbox.quarantine([event(1), event(2)], 'test');
    outbox.close();
    jest.spyOn(fs, 'readSync').mockImplementation(() => { throw new Error('startup EIO'); });
    expect(() => Outbox.open(dir, 1)).toThrow('startup EIO');
  });

  it.each(['write', 'fsync'])('%s failure preserves checkpoint and poisons further quarantine until reopen', (stage) => {
    outbox = Outbox.open(dir, 1);
    outbox.appendMany([event(1)]);
    const checkpoint = fs.readFileSync(join(dir, 'checkpoint.json'), 'utf8');
    const fault = stage === 'write'
      ? jest.spyOn(fs, 'writeSync').mockImplementation(() => { throw new Error('write EIO'); })
      : jest.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('fsync EIO'); });
    expect(() => outbox!.quarantine([event(1)], 'test')).toThrow('EIO');
    fault.mockRestore();
    expect(outbox.failedCount).toBe(0);
    expect(outbox.pendingCount).toBe(1);
    expect(fs.readFileSync(join(dir, 'checkpoint.json'), 'utf8')).toBe(checkpoint);
    expect(() => outbox!.quarantine([event(1)], 'test')).toThrow('reopen required');
    outbox.close();
    outbox = Outbox.open(dir, 1);
    outbox.quarantine([event(1)], 'test');
    expect(outbox.failedCount).toBe(1);
    expect(fs.readFileSync(join(dir, 'failed.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
