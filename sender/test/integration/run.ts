/**
 * sender 통합 검증 하네스 — 격리된 로컬 receiver/임시 DB 상대 시나리오 a~e.
 *
 * 실행: npm run sender:integration -- <a|b|c|d|e>
 * 전제: 로컬 PostgreSQL 접근 가능, npm run build (전용 receiver는 dist 사용)
 *
 * 최종 판정: 기록 성공 G = DB 원본 D ∪ 실패 저널 F, 중복/누락/중첩 없음, pending=0.
 * A/D/E의 G는 append+fsync 이후 별도 관측 파일이며 컴팩션과 독립적이다.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type { EventInput } from '../../../scripts/send-events';
import { Init1757310000000 } from '../../../src/database/migrations/1757310000000-Init';
import { Outbox } from '../../src/outbox';
import { compareIdentities } from './identity';
import { failedJournalIds } from '../../src/failed-journal';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://app:app@localhost:5432/gamelogs';
const INSTANCE_ID = '0fab3f2e-1894-41cd-b915-f99440a3ff32';
const API_KEY = process.env.INGEST_API_KEY ?? 'dev-ingest-key';

const EVIDENCE_ROOT = join(process.cwd(), 'sender/outbox-data/t3-followup-20260908');
mkdirSync(EVIDENCE_ROOT, { recursive: true });
const RUN_DIR = mkdtempSync(join(EVIDENCE_ROOT, 'run-'));
const RUN_LOG = join(RUN_DIR, 'run.jsonl');
const serverSnapshot = join(RUN_DIR, 'receiver-dist');
cpSync(join(process.cwd(), 'dist'), serverSnapshot, { recursive: true });

function evidence(fields: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  appendFileSync(RUN_LOG, line + '\n');
  console.log(line);
}

function sourceHashes(): Record<string, string> {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .trim().split('\n').filter((file) => /^(sender|scripts|src|test)\//.test(file) || /^(package.*json|tsconfig.*json)$/.test(file));
  return Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
}

const START_HASHES = sourceHashes();
writeFileSync(join(RUN_DIR, 'code-hashes.json'), JSON.stringify(START_HASHES, null, 2));
evidence({ kind: 'run_started', pid: process.pid, scenario: process.argv[2], run_dir: RUN_DIR, a_duration_ms: process.env.A_DURATION_MS ?? '600000', code_hash_file: join(RUN_DIR, 'code-hashes.json') });
process.on('exit', (code) => evidence({ kind: 'run_exit', code, source_unchanged: JSON.stringify(sourceHashes()) === JSON.stringify(START_HASHES) }));

// ── 공통 유틸 ─────────────────────────────────────────────

async function withDb<T>(
  databaseUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function countDbEvents(databaseUrl: string, whereSql = ''): Promise<number> {
  return withDb(databaseUrl, async (c) => {
    const res = await c.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM game_events ${whereSql}`,
    );
    return res.rows[0].count;
  });
}

async function dbEventIds(databaseUrl: string): Promise<Set<string>> {
  return withDb(databaseUrl, async (client) => {
    const result = await client.query<{ event_id: string }>(
      'SELECT event_id::text AS event_id FROM game_events',
    );
    return new Set(result.rows.map((row) => row.event_id));
  });
}

interface DaemonHandle {
  proc: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
  closed: boolean;
}

interface ReceiverHandle {
  proc: ChildProcess;
  exited: Promise<number | null>;
  closed: boolean;
}

interface ScenarioEnvironment {
  databaseName: string;
  databaseUrl: string;
  port: number;
  targetUrl: string;
  rateLimit: number;
  receiver: ReceiverHandle;
}

const activeDaemons = new Set<DaemonHandle>();
const activeDatabaseNames = new Set<string>();
let activeEnvironment: ScenarioEnvironment | undefined;

function databaseUrlFor(databaseName: string): string {
  const url = new URL(DB_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('integration requires loopback PostgreSQL');
  url.pathname = `/${databaseName}`;
  url.searchParams.delete('schema');
  return url.toString();
}

async function createIsolatedDatabase(tag: string): Promise<{
  name: string;
  url: string;
}> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const name = `sender_int_${tag}_${process.pid}_${suffix}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('unsafe temporary DB name');
  const adminUrl = databaseUrlFor('postgres');
  await withDb(adminUrl, (client) => client.query(`CREATE DATABASE "${name}"`));
  // migration/receiver 준비 중 신호가 와도 정확한 임시 DB를 정리할 수 있게 즉시 등록한다.
  activeDatabaseNames.add(name);
  const url = databaseUrlFor(name);
  const dataSource = new DataSource({
    type: 'postgres',
    url,
    entities: [],
    migrations: [Init1757310000000],
    synchronize: false,
  });
  try {
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    return { name, url };
  } catch (error) {
    if (dataSource.isInitialized) await dataSource.destroy();
    await dropIsolatedDatabase(name);
    throw error;
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

async function dropIsolatedDatabase(name: string): Promise<void> {
  if (!/^sender_int_[a-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to drop non-isolated database: ${name}`);
  }
  await withDb(databaseUrlFor('postgres'), async (client) => {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
  });
  activeDatabaseNames.delete(name);
}

async function availablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        server.close();
        reject(new Error('failed to allocate receiver port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startReceiver(
  databaseUrl: string,
  port: number,
  rateLimit: number,
): ReceiverHandle {
  const proc = spawn(process.execPath, [join(serverSnapshot, 'main.js')], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      INGEST_API_KEY: API_KEY,
      INGEST_INSTANCE_ID: INSTANCE_ID,
      ADMIN_API_KEY: 'sender-integration-admin-key',
      RATE_LIMIT_PER_MINUTE: String(rateLimit),
      PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  evidence({ kind: 'receiver_started', pid: proc.pid, port, database: new URL(databaseUrl).pathname.slice(1), build: serverSnapshot });
  const handle: ReceiverHandle = {
    proc,
    closed: false,
    exited: Promise.resolve(null),
  };
  handle.exited = new Promise<number | null>((resolve) => {
    proc.on('close', (code) => {
      handle.closed = true;
      resolve(code);
    });
  });
  return handle;
}

async function stopReceiver(handle: ReceiverHandle): Promise<void> {
  if (handle.closed) return;
  handle.proc.kill('SIGTERM');
  await waitForProcessClose(handle, 'receiver');
}

async function waitForProcessClose(
  handle: Pick<DaemonHandle, 'proc' | 'exited' | 'closed'>,
  label: string,
): Promise<void> {
  if (handle.closed) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!handle.closed) handle.proc.kill('SIGKILL');
      reject(new Error(`${label} did not stop within 35 seconds`));
    }, 35_000);
    handle.exited.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function waitForReceiver(targetUrl: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        return (await fetch(`${targetUrl}/health`)).ok;
      } catch {
        return false;
      }
    },
    30_000,
    `receiver ${targetUrl}`,
    100,
  );
}

async function createScenarioEnvironment(
  tag: string,
  rateLimit = 120,
): Promise<ScenarioEnvironment> {
  const database = await createIsolatedDatabase(tag);
  let receiver: ReceiverHandle | undefined;
  try {
    const port = await availablePort();
    const targetUrl = `http://127.0.0.1:${port}`;
    receiver = startReceiver(database.url, port, rateLimit);
    const environment: ScenarioEnvironment = {
      databaseName: database.name,
      databaseUrl: database.url,
      port,
      targetUrl,
      rateLimit,
      receiver,
    };
    activeEnvironment = environment;
    await waitForReceiver(targetUrl);
    return environment;
  } catch (error) {
    if (receiver && !receiver.closed) await stopReceiver(receiver);
    await dropIsolatedDatabase(database.name);
    if (activeEnvironment?.databaseName === database.name) {
      activeEnvironment = undefined;
    }
    throw error;
  }
}

async function destroyScenarioEnvironment(
  environment: ScenarioEnvironment,
): Promise<void> {
  try {
    await stopReceiver(environment.receiver);
  } finally {
    try {
      await dropIsolatedDatabase(environment.databaseName);
    } finally {
      if (activeEnvironment === environment) activeEnvironment = undefined;
    }
  }
}

function startDaemon(
  outboxDir: string,
  targetUrl: string,
  envOverrides: Record<string, string> = {},
): DaemonHandle {
  const proc = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', 'sender/test/integration/observed-daemon.ts'],
    {
      env: {
        ...process.env,
        INSTANCE_ID,
        API_KEY,
        TARGET_URL: targetUrl,
        // 호출 셸의 선택 env가 시나리오 의미를 바꾸지 않도록 기준 설정을 고정한다.
        USERS: '30',
        EVENT_RATE: '0.5',
        SEND_RATE_LIMIT: '60',
        OUTBOX_DIR: outboxDir,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const lines: string[] = [];
  const daemonLog = join(outboxDir, `daemon-${proc.pid}.jsonl`);
  mkdirSync(outboxDir, { recursive: true });
  evidence({ kind: 'daemon_started', pid: proc.pid, outbox_dir: outboxDir, log: daemonLog, target: targetUrl });
  let buffer = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    appendFileSync(daemonLog, chunk);
    buffer += chunk.toString('utf8');
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    lines.push(...parts.filter((l) => l !== ''));
  });
  const handle: DaemonHandle = {
    proc,
    lines,
    closed: false,
    exited: Promise.resolve(null),
  };
  handle.exited = new Promise<number | null>((resolve) => {
    // exit보다 close가 stdout drain 이후 발생하므로 마지막 stats/ACK 로그까지 보장한다.
    proc.on('close', (code) => {
      handle.closed = true;
      resolve(code);
    });
  });
  activeDaemons.add(handle);
  handle.exited.finally(() => activeDaemons.delete(handle)).catch(() => undefined);
  return handle;
}

async function stopDaemon(handle: DaemonHandle): Promise<void> {
  if (handle.closed) {
    const code = await handle.exited;
    throw new Error(`sender exited before requested shutdown (code=${code})`);
  }
  handle.proc.kill('SIGTERM');
  await waitForProcessClose(handle, 'sender');
  const code = await handle.exited;
  if (code !== 0) {
    throw new Error(`sender did not exit cleanly after SIGTERM (code=${code})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
  intervalMs = 1_000,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await cond()) return Date.now() - startedAt;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function outboxSnapshot(dir: string): {
  produced: number;
  failed: number;
  pending: number;
} {
  const outbox = Outbox.open(dir);
  try {
    return {
      produced: outbox.recordedCount,
      failed: outbox.failedCount,
      pending: outbox.pendingCount,
    };
  } finally {
    outbox.close();
  }
}

/**
 * SIGKILL 직후 sender 재시작보다 먼저 읽는 비변경 관측자.
 * Outbox.open()은 tail 복구/checkpoint 쓰기를 수행하므로 B의 독립 기준으로 쓰지 않는다.
 */
function rawJournalSnapshot(dir: string): {
  count: number;
  eventIds: Set<string>;
  incompleteTail: boolean;
} {
  const path = join(dir, 'outbox.jsonl');
  if (!existsSync(path)) {
    return { count: 0, eventIds: new Set(), incompleteTail: false };
  }
  const buffer = readFileSync(path);
  const lastNewline = buffer.lastIndexOf(0x0a);
  const completeLength = lastNewline < 0 ? 0 : lastNewline + 1;
  const incompleteTail = completeLength !== buffer.length;
  const lines = buffer
    .subarray(0, completeLength)
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '');
  const eventIds = new Set<string>();
  for (const line of lines) {
    const value = JSON.parse(line) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      !('event_id' in value) ||
      typeof value.event_id !== 'string'
    ) {
      throw new Error('raw outbox journal contains an invalid complete line');
    }
    if (eventIds.has(value.event_id)) {
      throw new Error(`raw outbox journal contains duplicate event_id: ${value.event_id}`);
    }
    eventIds.add(value.event_id);
  }
  return { count: lines.length, eventIds, incompleteTail };
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** 지금까지 컴팩션으로 저널에서 제거된 확인 완료 이벤트 수 (checkpoint.json) */
function compactedOutCount(dir: string): number {
  const path = join(dir, 'checkpoint.json');
  if (!existsSync(path)) return 0;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as {
      journalBaseCount?: unknown;
    };
    return Number.isInteger(value.journalBaseCount) &&
      (value.journalBaseCount as number) >= 0
      ? (value.journalBaseCount as number)
      : 0;
  } catch {
    return 0;
  }
}

/** Independent post-fsync observer survives outbox compaction. Raw row counts remain visible. */
async function recordedIdsMatchDb(dir: string, databaseUrl: string) {
  const generated = readFileSync(join(dir, 'recorded-ids.txt'), 'utf8').split('\n').filter(Boolean);
  const stored = await withDb(databaseUrl, async (client) => {
    const result = await client.query<{ event_id: string }>('SELECT event_id::text AS event_id FROM game_events');
    return result.rows.map((row) => row.event_id);
  });
  const failedPath = join(dir, 'failed.jsonl');
  const failed = existsSync(failedPath) ? [...failedJournalIds(failedPath)].map((row) => row.id) : [];
  const result = compareIdentities(generated, stored, failed);
  writeFileSync(join(dir, 'identity-result.json'), JSON.stringify(result, null, 2));
  return result;
}

interface StatsLine {
  ts?: string;
  msg: string;
  pending?: number;
  outbox_pending?: number;
  generated?: number;
  generation_attempted?: number;
  recorded?: number;
  unrecorded?: number;
  max_pending?: number;
  count?: number;
  rate_limited_waits?: number;
  retry_after_s?: number;
  wait_ms?: number;
  duration_ms?: number;
  batches?: number;
  batch_counts?: number[];
}

function parsedLines(lines: string[]): StatsLine[] {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as StatsLine];
    } catch {
      return [];
    }
  });
}

function maxPending(lines: string[]): number {
  return parsedLines(lines)
    .reduce(
      (max, line) =>
        Math.max(
          max,
          line.pending ?? 0,
          line.outbox_pending ?? 0,
          line.max_pending ?? 0,
        ),
      0,
    );
}

function latestPending(lines: string[]): number {
  const values = parsedLines(lines).flatMap((line) => {
    const pending = line.pending ?? line.outbox_pending;
    return pending === undefined ? [] : [pending];
  });
  return values.length > 0 ? values[values.length - 1] : NaN;
}

interface Accounting {
  produced: number;
  db: number;
  failed: number;
  pending: number;
  lost: number;
}

async function account(dir: string, databaseUrl: string): Promise<Accounting> {
  // recordedCount는 컴팩션 후에도 유지되는 outbox 독립 누적 카운터다.
  const snapshot = outboxSnapshot(dir);
  const produced = snapshot.produced;
  const db = await countDbEvents(databaseUrl);
  const failed = snapshot.failed;
  const pending = snapshot.pending;
  return { produced, db, failed, pending, lost: produced - db - failed - pending };
}

function report(scenario: string, fields: Record<string, unknown>): void {
  if (JSON.stringify(sourceHashes()) !== JSON.stringify(START_HASHES)) {
    throw new Error('source changed during verification; result invalid');
  }
  evidence({ kind: 'scenario_result', scenario, ...fields });
  if (fields.ok !== true) throw new Error(`scenario ${scenario} failed`);
}

async function drainOutbox(
  dir: string,
  targetUrl: string,
  timeoutMs = 180_000,
): Promise<{ elapsedMs: number; lines: string[] }> {
  if (outboxSnapshot(dir).pending === 0) return { elapsedMs: 0, lines: [] };
  const daemon = startDaemon(dir, targetUrl, {
    USERS: '0',
    EVENT_RATE: '0',
  });
  const startedAt = Date.now();
  try {
    await waitFor(
      () =>
        parsedLines(daemon.lines).some(
          (line) => line.msg === 'startup drain completed',
        ),
      timeoutMs,
      'drain-only sender completed startup backlog',
      100,
    );
  } finally {
    await stopDaemon(daemon);
  }
  return { elapsedMs: Date.now() - startedAt, lines: daemon.lines };
}

function fixedWindowMaxRequests(lines: string[]): number {
  const windows = new Map<number, number>();
  for (const line of parsedLines(lines)) {
    if (line.msg !== 'batch send started' || !line.ts) continue;
    const timestamp = Date.parse(line.ts);
    if (!Number.isFinite(timestamp)) continue;
    const window = Math.floor(timestamp / 60_000);
    windows.set(window, (windows.get(window) ?? 0) + 1);
  }
  return Math.max(0, ...windows.values());
}

function observedRetryAfterWaits(lines: string[]): number[] {
  const parsed = parsedLines(lines);
  const waits: number[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const limited = parsed[index];
    if (
      limited.msg !== 'rate limited by server, waiting retry-after + jitter' ||
      !limited.ts ||
      limited.retry_after_s === undefined
    ) {
      continue;
    }
    const nextSend = parsed
      .slice(index + 1)
      .find((line) => line.msg === 'batch send started' && line.ts);
    if (!nextSend?.ts) continue;
    waits.push(Date.parse(nextSend.ts) - Date.parse(limited.ts));
  }
  return waits;
}

function newOutboxDir(tag: string): string {
  return mkdtempSync(join(RUN_DIR, `outbox-${tag}-`));
}

function makePreseedEvent(i: number): EventInput {
  return {
    instance_id: INSTANCE_ID,
    event_id: randomUUID(),
    event_type: 'monster_kill',
    user_id: 1001 + (i % 30),
    character_id: 10011,
    session_id: 's-preseed',
    channel_id: 'channel-01',
    payload: { monster_id: `mob-${i % 30}`, map_id: 'map-1' },
    // 2050년으로 구분 — drain 완료 판정을 DB에서 occurred_at으로 셀 수 있게
    occurred_at: new Date(Date.UTC(2050, 0, 1, 0, 0, i % 60_000)).toISOString(),
  };
}

// ── 시나리오 ─────────────────────────────────────────────

/** a. 장기 가동 → 생성 = DB + 실패 저널 (+잔량), 유실 0 */
async function scenarioA(): Promise<void> {
  const durationMs = Number(process.env.A_DURATION_MS ?? 600_000);
  const environment = await createScenarioEnvironment('a');
  try {
    const dir = newOutboxDir('a');
    const daemon = startDaemon(dir, environment.targetUrl);
    await waitFor(() => parsedLines(daemon.lines).some((line) => line.msg === 'sender started'), 30_000, 'sender ready');
    const started = parsedLines(daemon.lines).find((line) => line.msg === 'sender started')!;
    const startedAt = Date.parse(started.ts!);
    const stopAt = startedAt + durationMs;
    try {
      while (Date.now() < stopAt) {
        await sleep(Math.min(30_000, stopAt - Date.now()));
        const stats = parsedLines(daemon.lines).filter((line) => line.msg === 'stats').at(-1);
        evidence({ kind: 'soak_progress', elapsed_ms: Date.now() - startedAt, daemon_alive: !daemon.closed, stats });
        if (daemon.closed) throw new Error('soak daemon exited early');
      }
    } finally {
      await stopDaemon(daemon);
    }
    const pendingAtStop = outboxSnapshot(dir).pending;
    const finalDrain = await drainOutbox(dir, environment.targetUrl);
    const acc = await account(dir, environment.databaseUrl);
    const compactedOut = compactedOutCount(dir);
    const idCheck = await recordedIdsMatchDb(dir, environment.databaseUrl);
    report('a', {
      isolated_database: environment.databaseName,
      outbox_dir: dir,
      started_at: started.ts,
      generation_stopped_at: parsedLines(daemon.lines).find((line) => line.msg === 'generation stopped')?.ts,
      final_drain_completed_at: new Date().toISOString(),
      configured_duration_ms: durationMs,
      generation_duration_ms: Date.parse(parsedLines(daemon.lines).find((line) => line.msg === 'generation stopped')!.ts!) - startedAt,
      generation_totals: parsedLines(daemon.lines).find((line) => line.msg === 'generation stopped'),
      duration_s: Math.round((Date.now() - startedAt) / 1000),
      ...acc,
      max_backlog: maxPending(daemon.lines),
      pending_at_generation_stop: pendingAtStop,
      final_drain_ms: finalDrain.elapsedMs,
      compaction_occurred: compactedOut > 0,
      compacted_out: compactedOut,
      ...idCheck,
      ok:
        Date.parse(parsedLines(daemon.lines).find((line) => line.msg === 'generation stopped')!.ts!) - startedAt >= durationMs &&
        acc.produced > 0 &&
        acc.lost === 0 &&
        acc.failed === 0 &&
        acc.pending === 0 &&
        acc.produced === acc.db &&
        idCheck.event_ids_match && idCheck.failed_raw === 0,
    });
  } finally {
    await destroyScenarioEnvironment(environment);
  }
}

/** b. SIGKILL → 재시작 후 outbox 이어서 전송 → 최종 정합 (T3 완료 조건) */
async function scenarioB(): Promise<void> {
  const environment = await createScenarioEnvironment('b');
  try {
    const dir = newOutboxDir('b');
    // 도달 불가 전용 포트로 적체를 만든 뒤 SIGKILL한다. 공유 receiver에는 영향 없음.
    const unreachablePort = await availablePort();
    const first = startDaemon(dir, `http://127.0.0.1:${unreachablePort}`);
    let survivedUntilKill = false;
    try {
      await sleep(Number(process.env.B_ACCUMULATE_MS ?? 40_000));
      survivedUntilKill = !first.closed;
    } finally {
      if (!first.closed) first.proc.kill('SIGKILL');
      await first.exited;
    }
    // 복구 코드를 먼저 실행하지 않고, SIGKILL이 남긴 journal을 그대로 독립 캡처한다.
    const atKill = rawJournalSnapshot(dir);
    const producedAtKill = atKill.count;
    const dbAtKill = await countDbEvents(environment.databaseUrl);

    const second = startDaemon(dir, environment.targetUrl, {
      EVENT_RATE: '0',
      USERS: '0',
    });
    let drainMs = 0;
    try {
      drainMs = await waitFor(
        () =>
          parsedLines(second.lines).some(
            (line) => line.msg === 'startup drain completed',
          ),
        120_000,
        'outbox drained after restart',
        100,
      );
    } finally {
      await stopDaemon(second);
    }
    const acc = await account(dir, environment.databaseUrl);
    const storedIds = await dbEventIds(environment.databaseUrl);
    const recoveredExactly = sameStringSet(atKill.eventIds, storedIds);
    const identities = compareIdentities([...atKill.eventIds], [...storedIds], []);
    report('b', {
      isolated_database: environment.databaseName,
      outbox_dir: dir,
      produced_at_kill: producedAtKill,
      db_at_kill: dbAtKill,
      backlog_at_kill: atKill.count,
      incomplete_tail_at_kill: atKill.incompleteTail,
      drain_after_restart_ms: drainMs,
      recovered_event_ids_exactly: recoveredExactly,
      ...identities,
      ...acc,
      ok:
        survivedUntilKill &&
        atKill.count > 0 &&
        acc.produced === atKill.count &&
        recoveredExactly &&
        acc.lost === 0 &&
        acc.failed === 0 &&
        acc.pending === 0 &&
        acc.produced === acc.db,
    });
  } finally {
    await destroyScenarioEnvironment(environment);
  }
}

/** c. drain: outbox 5,000건 사전 적재 → 500건 배치 최단 소화 (§2.2 대조) */
async function scenarioC(): Promise<void> {
  const environment = await createScenarioEnvironment('c');
  try {
    const dir = newOutboxDir('c');
    const PRESEED = 5_000;
    const preseedEvents = Array.from({ length: PRESEED }, (_, i) =>
      makePreseedEvent(i),
    );
    const outbox = Outbox.open(dir);
    outbox.appendMany(preseedEvents);
    outbox.close();

    const startedAt = Date.now();
    const daemon = startDaemon(dir, environment.targetUrl);
    let drainCompleted: StatsLine | undefined;
    try {
      await waitFor(
        () =>
          parsedLines(daemon.lines).some(
            (line) => line.msg === 'startup drain completed',
          ),
        120_000,
        'preseeded 5000 events acked and checkpointed',
        100,
      );
      drainCompleted = parsedLines(daemon.lines).find(
        (line) => line.msg === 'startup drain completed',
      );
      await sleep(3_000);
    } finally {
      await stopDaemon(daemon);
    }
    const pendingAtStop = outboxSnapshot(dir).pending;
    await drainOutbox(dir, environment.targetUrl);
    const acc = await account(dir, environment.databaseUrl);
    const storedIds = await dbEventIds(environment.databaseUrl);
    const preseedStored = preseedEvents.filter((event) =>
      storedIds.has(event.event_id),
    ).length;
    const batchCounts = drainCompleted?.batch_counts ?? [];
    const fixedWindowPeak = fixedWindowMaxRequests(daemon.lines);
    const generatedIds = readFileSync(join(dir, 'recorded-ids.txt'), 'utf8').split('\n').filter(Boolean);
    const identities = compareIdentities([...preseedEvents.map((event) => event.event_id), ...generatedIds], [...storedIds], []);
    report('c', {
      isolated_database: environment.databaseName,
      outbox_dir: dir,
      preseeded: PRESEED,
      preseeded_stored: preseedStored,
      ...identities,
      drain_ms: drainCompleted?.duration_ms,
      drain_batches_sent: drainCompleted?.batches,
      drain_batch_counts: batchCounts,
      fixed_window_peak_requests: fixedWindowPeak,
      elapsed_s: Math.round((Date.now() - startedAt) / 1000),
      pending_at_generation_stop: pendingAtStop,
      ...acc,
      ok:
        drainCompleted?.batches === 10 &&
        batchCounts.length === 10 &&
        batchCounts.every((count) => count === 500) &&
        preseedStored === PRESEED &&
        identities.event_ids_match &&
        (drainCompleted.duration_ms ?? Infinity) < 60_000 &&
        fixedWindowPeak <= 60 &&
        acc.lost === 0 &&
        acc.failed === 0 &&
        acc.pending === 0 &&
        acc.produced === acc.db,
    });
  } finally {
    await destroyScenarioEnvironment(environment);
  }
}

/** d. receiver 60초 정지 → 적체 → 재기동 → 자동 회복, 유실 0 (T8 시나리오 A 로컬판) */
async function scenarioD(): Promise<void> {
  const environment = await createScenarioEnvironment('d');
  let daemon: DaemonHandle | undefined;
  try {
    const dir = newOutboxDir('d');
    daemon = startDaemon(dir, environment.targetUrl);
    const activeDaemon = daemon;
    let downAt = 0;
    let upAt = 0;
    let backlogDuringOutage = 0;
    let recoveryMs = 0;
    await sleep(Number(process.env.D_WARMUP_MS ?? 20_000));
    await stopReceiver(environment.receiver);
    downAt = Date.now();
    await sleep(Number(process.env.D_OUTAGE_MS ?? 60_000));
    backlogDuringOutage = maxPending(activeDaemon.lines);

    environment.receiver = startReceiver(
      environment.databaseUrl,
      environment.port,
      environment.rateLimit,
    );
    await waitForReceiver(environment.targetUrl);
    upAt = Date.now();
    recoveryMs = await waitFor(
      () => latestPending(activeDaemon.lines) <= 30,
      120_000,
      'backlog drained after receiver restart',
      100,
    );
    await sleep(2_000);
    await stopDaemon(activeDaemon);
    const pendingAtStop = outboxSnapshot(dir).pending;
    await drainOutbox(dir, environment.targetUrl);
    const acc = await account(dir, environment.databaseUrl);
    const idCheck = await recordedIdsMatchDb(dir, environment.databaseUrl);
    report('d', {
      isolated_database: environment.databaseName,
      outbox_dir: dir,
      outage_s: Math.round((upAt - downAt) / 1000),
      backlog_during_outage: backlogDuringOutage,
      max_backlog: maxPending(activeDaemon.lines),
      generation_totals: parsedLines(activeDaemon.lines).find((line) => line.msg === 'generation stopped'),
      recovery_ms_after_up: recoveryMs,
      pending_at_generation_stop: pendingAtStop,
      ...idCheck,
      ...acc,
      ok:
        backlogDuringOutage > 30 &&
        recoveryMs > 0 &&
        acc.lost === 0 &&
        acc.failed === 0 &&
        acc.pending === 0 &&
        acc.produced === acc.db &&
        idCheck.event_ids_match && idCheck.failed_raw === 0,
    });
  } finally {
    if (daemon && !daemon.closed) await stopDaemon(daemon);
    await destroyScenarioEnvironment(environment);
  }
}

/** e. 서버 한도 10회/분으로 낮춰 429 유도 → Retry-After 준수 확인 */
async function scenarioE(): Promise<void> {
  const environment = await createScenarioEnvironment('e', 10);
  let daemon: DaemonHandle | undefined;
  try {
    const dir = newOutboxDir('e');
    daemon = startDaemon(dir, environment.targetUrl);
    await sleep(Number(process.env.E_DURATION_MS ?? 100_000));
    await stopDaemon(daemon);

    const rateLimitedLogs = parsedLines(daemon.lines).filter(
      (l) => l.msg === 'rate limited by server, waiting retry-after + jitter',
    );
    // 계산 로그가 아니라 429 수신 로그 시각 → 다음 실제 send 시작 시각을 대조한다.
    const observedWaits = observedRetryAfterWaits(daemon.lines);
    const comparableLimitedLogs = rateLimitedLogs.slice(0, observedWaits.length);
    const honored =
      observedWaits.length > 0 &&
      observedWaits.every(
        (wait, index) =>
          wait >= (comparableLimitedLogs[index].retry_after_s ?? Infinity) * 1_000,
      );
    const fixedWindowPeak = fixedWindowMaxRequests(daemon.lines);

    // 같은 격리 DB의 receiver만 정상 한도로 재기동해 남은 outbox를 최종 drain한다.
    await stopReceiver(environment.receiver);
    environment.rateLimit = 120;
    environment.receiver = startReceiver(
      environment.databaseUrl,
      environment.port,
      environment.rateLimit,
    );
    await waitForReceiver(environment.targetUrl);
    const finalDrain = await drainOutbox(dir, environment.targetUrl);
    const acc = await account(dir, environment.databaseUrl);
    const idCheck = await recordedIdsMatchDb(dir, environment.databaseUrl);
    report('e', {
      isolated_database: environment.databaseName,
      outbox_dir: dir,
      rate_limited_count: rateLimitedLogs.length,
      max_backlog: maxPending(daemon.lines),
      generation_totals: parsedLines(daemon.lines).find((line) => line.msg === 'generation stopped'),
      observed_retry_wait_ms: observedWaits,
      retry_after_honored: honored,
      fixed_window_peak_requests: fixedWindowPeak,
      sample: rateLimitedLogs[0] ?? null,
      final_drain_ms: finalDrain.elapsedMs,
      ...idCheck,
      ...acc,
      ok:
        acc.lost === 0 &&
        acc.failed === 0 &&
        acc.pending === 0 &&
        acc.produced === acc.db &&
        rateLimitedLogs.length > 0 &&
        honored &&
        fixedWindowPeak <= 60 &&
        idCheck.event_ids_match && idCheck.failed_raw === 0,
    });
  } finally {
    if (daemon && !daemon.closed) await stopDaemon(daemon);
    await destroyScenarioEnvironment(environment);
  }
}

/** Fresh disposable DB only: retain original seed/demo expectations unchanged. */
async function scenarioSeedDemo(): Promise<void> {
  const environment = await createScenarioEnvironment('seed');
  try {
    if (await countDbEvents(environment.databaseUrl) !== 0) throw new Error('seed DB is not empty');
    const outputs: Record<string, string> = {};
    for (const command of ['seed', 'demo']) {
      const child = spawn('npm', ['run', command], {
        cwd: process.cwd(),
        env: { ...process.env, BASE_URL: environment.targetUrl, INGEST_API_KEY: API_KEY, ADMIN_API_KEY: 'sender-integration-admin-key' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      outputs[command] = output;
      writeFileSync(join(RUN_DIR, command + '.log'), output);
      evidence({ kind: 'command_exit', command: 'npm run ' + command, code });
      if (code !== 0) throw new Error(command + ' failed');
    }
    const seeded = /stored 11 \/ duplicate 1/.test(outputs.seed);
    const metricPasses = outputs.demo.split('\n').filter((line) => /^PASS {2}(DAU|매출|결제|리텐션|참여율)/.test(line)).length;
    report('seed-demo', {
      isolated_database: environment.databaseName,
      seed_stored_11_duplicate_1: seeded,
      demo_metric_passes: metricPasses,
      ok: seeded && metricPasses === 5 && !outputs.demo.includes('FAIL'),
    });
  } finally {
    await destroyScenarioEnvironment(environment);
  }
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const label = [command, ...args].join(' ');
  const path = join(RUN_DIR, `command-${label.replace(/[^a-z0-9]+/gi, '-')}.log`);
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  evidence({ kind: 'command_started', command: label, pid: child.pid, log: path });
  child.stdout.on('data', (data: Buffer) => appendFileSync(path, data));
  child.stderr.on('data', (data: Buffer) => appendFileSync(path, data));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  evidence({ kind: 'command_exit', command: label, code, log: path });
  if (code !== 0) throw new Error(`${label} failed; see ${path}`);
}

async function scenarioRegression(): Promise<void> {
  // All are non-fixing source checks; build only writes the normal ignored dist.
  for (const args of [
    ['run', 'lint'], ['run', 'build'], ['run', 'sender:test'], ['test', '--', '--runInBand'],
  ]) await runCommand('npm', args);
  await runCommand('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']);
  const database = await createIsolatedDatabase('e2e');
  try {
    // Existing server tests delete all rows; only this newly created disposable DB
    // is passed to them. Their source and expectations are unchanged.
    await runCommand('npm', ['run', 'test:e2e'], { ...process.env, DATABASE_URL: database.url });
  } finally {
    await dropIsolatedDatabase(database.name);
  }
  report('regression', { ok: true });
}

// ── 엔트리 ───────────────────────────────────────────────

const SCENARIOS: Record<string, () => Promise<void>> = {
  regression: scenarioRegression,
  'seed-demo': scenarioSeedDemo,
  a: scenarioA,
  b: scenarioB,
  c: scenarioC,
  d: scenarioD,
  e: scenarioE,
};

let cleaningUpSignal = false;

async function cleanupAfterSignal(signal: NodeJS.Signals): Promise<never> {
  if (cleaningUpSignal) await new Promise<never>(() => undefined);
  cleaningUpSignal = true;
  const exitCode = signal === 'SIGINT' ? 130 : 143;
  try {
    await Promise.allSettled(
      [...activeDaemons].map(async (daemon) => {
        if (!daemon.closed) daemon.proc.kill('SIGTERM');
        await Promise.race([daemon.exited, sleep(5_000)]);
        if (!daemon.closed) {
          daemon.proc.kill('SIGKILL');
          await daemon.exited;
        }
      }),
    );
    const environment = activeEnvironment;
    if (environment) {
      try {
        await stopReceiver(environment.receiver);
      } finally {
        await dropIsolatedDatabase(environment.databaseName);
        if (activeEnvironment === environment) activeEnvironment = undefined;
      }
    }
    // CREATE 직후~receiver 등록 전 신호가 온 migration 준비 구간도 회수한다.
    for (const databaseName of [...activeDatabaseNames]) {
      await dropIsolatedDatabase(databaseName);
    }
  } catch (error) {
    console.error(
      `signal cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    process.exit(exitCode);
  }
}

// npm/TTY가 같은 신호를 두 번 전달해도 두 번째 신호의 기본 동작으로 정리 중인
// 프로세스가 즉시 종료되지 않도록 listener를 유지한다.
process.on('SIGINT', () => {
  void cleanupAfterSignal('SIGINT');
});
process.on('SIGTERM', () => {
  void cleanupAfterSignal('SIGTERM');
});

async function main(): Promise<void> {
  const name = process.argv[2];
  const scenario = name ? SCENARIOS[name] : undefined;
  if (!scenario) {
    console.error('usage: npm run sender:integration -- <a|b|c|d|e|seed-demo|regression>');
    process.exit(2);
  }
  await scenario();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
