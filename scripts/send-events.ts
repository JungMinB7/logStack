/**
 * 적재 클라이언트 — 이벤트 배열을 배치로 쪼개 POST /api/v1/event-batches로 전송한다.
 *
 * 전송 방식은 design.md §4.1의 배칭 상한을 따른다:
 * - 배치당 최대 500건 (서버 계약과 동일)
 * - 직렬화 크기 소프트 상한 3MB (서버 하드 제한 4MB보다 낮게)
 *
 * 사용 (라이브러리): sendEvents(events, { baseUrl, apiKey })
 * 사용 (CLI):       npx ts-node scripts/send-events.ts <events.json>
 *   환경변수: BASE_URL (기본 http://localhost:3000), INGEST_API_KEY (기본 dev-ingest-key)
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface EventInput {
  instance_id: string;
  event_id: string;
  event_type: string;
  user_id: number;
  character_id: number;
  session_id: string;
  channel_id: string;
  payload: Record<string, unknown>;
  /** ISO8601 — 시간대 지정자(Z 또는 ±hh:mm) 필수. 없으면 적재 시 rejected */
  occurred_at: string;
}

export interface BatchResponse {
  batch_id: string;
  received_count: number;
  accepted_count: number;
  stored_count: number;
  duplicate_count: number;
  order_duplicate_count: number;
  rejected_count: number;
  rejected: Array<{
    index: number;
    event_id?: string;
    code: string;
    message: string;
  }>;
}

export interface SendSummary {
  batches: number;
  received: number;
  accepted: number;
  stored: number;
  duplicate: number;
  orderDuplicate: number;
  rejected: number;
  rejectedItems: BatchResponse['rejected'];
}

export const MAX_EVENTS_PER_BATCH = 500;
export const MAX_BATCH_BYTES = 3 * 1024 * 1024; // 3MB 소프트 상한

const BATCH_ID_SIZE_TEMPLATE = '00000000-0000-4000-8000-000000000000';
const SENT_AT_SIZE_TEMPLATE = '2000-01-01T00:00:00.000Z';

/**
 * 실제 요청 JSON의 고정 envelope 크기. batch_id(UUID)와 sent_at(ISO8601)은
 * 언제나 템플릿과 같은 ASCII 바이트 길이이므로 이벤트·쉼표 크기만 더하면 정확하다.
 */
export const EMPTY_BATCH_BODY_BYTES = Buffer.byteLength(
  JSON.stringify({
    batch_id: BATCH_ID_SIZE_TEMPLATE,
    sent_at: SENT_AT_SIZE_TEMPLATE,
    events: [],
  }),
  'utf8',
);

export function batchBodyByteLength(events: readonly EventInput[]): number {
  return events.reduce(
    (bytes, event, index) =>
      bytes +
      Buffer.byteLength(JSON.stringify(event), 'utf8') +
      (index === 0 ? 0 : 1),
    EMPTY_BATCH_BODY_BYTES,
  );
}

export function serializeBatch(
  batchId: string,
  sentAt: string,
  events: readonly EventInput[],
): string {
  return JSON.stringify({ batch_id: batchId, sent_at: sentAt, events });
}

/** 500건/3MB 상한을 지키며 이벤트 배열을 배치로 나눈다 */
export function chunkEvents(events: EventInput[]): EventInput[][] {
  const chunks: EventInput[][] = [];
  let current: EventInput[] = [];
  let currentBytes = EMPTY_BATCH_BODY_BYTES;
  for (const event of events) {
    const size =
      Buffer.byteLength(JSON.stringify(event), 'utf8') +
      (current.length === 0 ? 0 : 1);
    if (
      current.length > 0 &&
      (current.length >= MAX_EVENTS_PER_BATCH ||
        currentBytes + size > MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = EMPTY_BATCH_BODY_BYTES;
    }
    const separatorBytes = current.length === 0 ? 0 : 1;
    current.push(event);
    currentBytes +=
      Buffer.byteLength(JSON.stringify(event), 'utf8') + separatorBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type BatchResponseValidation =
  | { ok: true; response: BatchResponse }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * design.md §4.2 ACK 검증의 단일 구현. 응답 카운트뿐 아니라 실제 전송 배치와
 * received_count 및 rejected index/event_id를 대조한다. 신뢰할 수 없는 200 응답으로
 * 체크포인트를 전진시키면 유실이므로, 하나라도 맞지 않으면 전체 재전송 대상이다.
 */
export function validateBatchResponse(
  value: unknown,
  expectedBatchId: string,
  expectedEvents: readonly Pick<EventInput, 'event_id'>[],
): BatchResponseValidation {
  if (!isRecord(value)) return { ok: false, reason: 'body schema invalid' };
  if (value.batch_id !== expectedBatchId) {
    return { ok: false, reason: 'batch_id mismatch' };
  }

  const countFields = [
    'received_count',
    'accepted_count',
    'stored_count',
    'duplicate_count',
    'order_duplicate_count',
    'rejected_count',
  ] as const;
  if (
    countFields.some(
      (field) =>
        !Number.isInteger(value[field]) || (value[field] as number) < 0,
    ) ||
    !Array.isArray(value.rejected)
  ) {
    return { ok: false, reason: 'body schema invalid' };
  }

  const received = value.received_count as number;
  const accepted = value.accepted_count as number;
  const stored = value.stored_count as number;
  const duplicate = value.duplicate_count as number;
  const orderDuplicate = value.order_duplicate_count as number;
  const rejectedCount = value.rejected_count as number;

  if (received !== expectedEvents.length) {
    return { ok: false, reason: 'received_count mismatch' };
  }
  if (
    received !== accepted + rejectedCount ||
    accepted !== stored + duplicate ||
    orderDuplicate > stored ||
    value.rejected.length !== rejectedCount
  ) {
    return { ok: false, reason: 'count invariant violated' };
  }

  const seenIndexes = new Set<number>();
  for (const rejected of value.rejected) {
    if (!isRecord(rejected)) {
      return { ok: false, reason: 'rejected entry invalid' };
    }
    const index = rejected.index;
    if (
      !Number.isInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= expectedEvents.length ||
      seenIndexes.has(index as number) ||
      typeof rejected.code !== 'string' ||
      rejected.code.length === 0 ||
      typeof rejected.message !== 'string' ||
      rejected.message.length > 200
    ) {
      return { ok: false, reason: 'rejected entry invalid' };
    }
    const numericIndex = index as number;
    if (
      rejected.event_id !== undefined &&
      rejected.event_id !== expectedEvents[numericIndex].event_id
    ) {
      return { ok: false, reason: 'rejected event_id mismatch' };
    }
    seenIndexes.add(numericIndex);
  }

  return { ok: true, response: value as unknown as BatchResponse };
}

export function parseBatchResponse(
  bodyText: string,
  expectedBatchId: string,
  expectedEvents: readonly Pick<EventInput, 'event_id'>[],
): BatchResponseValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return { ok: false, reason: 'body parse failed' };
  }
  return validateBatchResponse(parsed, expectedBatchId, expectedEvents);
}

export interface SendOptions {
  baseUrl?: string;
  apiKey?: string;
}

export async function sendEvents(
  events: EventInput[],
  options: SendOptions = {},
): Promise<SendSummary> {
  const baseUrl =
    options.baseUrl ?? process.env.BASE_URL ?? 'http://localhost:3000';
  const apiKey =
    options.apiKey ?? process.env.INGEST_API_KEY ?? 'dev-ingest-key';

  const summary: SendSummary = {
    batches: 0,
    received: 0,
    accepted: 0,
    stored: 0,
    duplicate: 0,
    orderDuplicate: 0,
    rejected: 0,
    rejectedItems: [],
  };

  for (const chunk of chunkEvents(events)) {
    const batchId = randomUUID();
    const sentAt = new Date().toISOString();
    const res = await fetch(`${baseUrl}/api/v1/event-batches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: serializeBatch(batchId, sentAt, chunk),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`ingest failed: HTTP ${res.status} ${text}`);
    }
    const validation = parseBatchResponse(await res.text(), batchId, chunk);
    if (!validation.ok) {
      throw new Error(`ingest failed: ${validation.reason} in response`);
    }
    const body = validation.response;

    summary.batches += 1;
    summary.received += body.received_count;
    summary.accepted += body.accepted_count;
    summary.stored += body.stored_count;
    summary.duplicate += body.duplicate_count;
    summary.orderDuplicate += body.order_duplicate_count;
    summary.rejected += body.rejected_count;
    summary.rejectedItems.push(...body.rejected);
  }

  return summary;
}

// ── CLI ─────────────────────────────────────────────────────
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npx ts-node scripts/send-events.ts <events.json>');
    process.exit(2);
  }
  const events = JSON.parse(readFileSync(file, 'utf8')) as EventInput[];
  const summary = await sendEvents(events);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.rejected > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
