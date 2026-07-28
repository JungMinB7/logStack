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

/** 500건/3MB 상한을 지키며 이벤트 배열을 배치로 나눈다 */
export function chunkEvents(events: EventInput[]): EventInput[][] {
  const chunks: EventInput[][] = [];
  let current: EventInput[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    if (
      current.length > 0 &&
      (current.length >= MAX_EVENTS_PER_BATCH ||
        currentBytes + size > MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
    const res = await fetch(`${baseUrl}/api/v1/event-batches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        batch_id: batchId,
        sent_at: new Date().toISOString(),
        events: chunk,
      }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`ingest failed: HTTP ${res.status} ${text}`);
    }
    const body = (await res.json()) as BatchResponse;

    // 전송측 규칙: HTTP 상태가 아니라 본문을 파싱해 batch_id를 대조한다 (design.md §4.2)
    if (body.batch_id !== batchId) {
      throw new Error('ingest failed: batch_id mismatch in response');
    }
    // 카운트 불변식 검증 (AI_RULES 18)
    if (
      body.received_count !== body.accepted_count + body.rejected_count ||
      body.accepted_count !== body.stored_count + body.duplicate_count ||
      body.order_duplicate_count > body.stored_count
    ) {
      throw new Error('ingest failed: count invariant violated in response');
    }

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
