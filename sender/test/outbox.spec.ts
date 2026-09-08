import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventInput } from '../../scripts/send-events';
import { COMPACT_THRESHOLD_BYTES, Outbox } from '../src/outbox';

function makeEvent(i: number, payload: Record<string, unknown> = {}): EventInput {
  return {
    instance_id: '0fab3f2e-1894-41cd-b915-f99440a3ff32',
    event_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    event_type: 'monster_kill',
    user_id: 1001,
    character_id: 10011,
    session_id: 's-1',
    channel_id: 'channel-01',
    payload,
    occurred_at: '2049-06-01T00:00:00.000Z',
  };
}

describe('Outbox — append 저널 + 체크포인트 + 컴팩션 [A-26]', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sender-outbox-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('confirm은 체크포인트만 전진시키고, 재기동 시 미확인분만 이어서 전송한다', () => {
    const outbox = Outbox.open(dir);
    outbox.appendMany([makeEvent(1), makeEvent(2), makeEvent(3)]);
    expect(outbox.pendingCount).toBe(3);
    outbox.confirm(2); // 앞 2건 전송 확인
    expect(outbox.pendingCount).toBe(1);
    outbox.close();

    // 프로세스 재시작을 흉내 — 체크포인트 이후(미확인 1건)만 남아야 한다
    const reopened = Outbox.open(dir);
    expect(reopened.pendingCount).toBe(1);
    expect(reopened.peekBatch(10, 1e9)[0].event_id).toBe(
      makeEvent(3).event_id,
    );
    reopened.close();
  });

  it('SIGKILL 잔여(끝의 불완전 라인)는 버리고 정상 라인만 복구한다', () => {
    const outbox = Outbox.open(dir);
    outbox.appendMany([makeEvent(1)]);
    outbox.close();
    // append 도중 크래시를 흉내 — JSON이 잘린 마지막 라인
    appendFileSync(join(dir, 'outbox.jsonl'), '{"event_id":"trunc');

    const reopened = Outbox.open(dir);
    expect(reopened.pendingCount).toBe(1);
    expect(reopened.truncatedLines).toBe(1);
    // tail을 메모리에서만 무시하면 이 append가 손상 JSON suffix에 붙어 함께 유실된다.
    reopened.appendMany([makeEvent(2)]);
    reopened.close();

    const reopenedAgain = Outbox.open(dir);
    expect(reopenedAgain.pendingCount).toBe(2);
    expect(reopenedAgain.peekBatch(10, 1e9).map((e) => e.event_id)).toEqual([
      makeEvent(1).event_id,
      makeEvent(2).event_id,
    ]);
    reopenedAgain.close();
  });

  it('개행까지 기록된 중간 손상은 조용히 버리지 않고 fail-closed 한다', () => {
    const outbox = Outbox.open(dir);
    outbox.appendMany([makeEvent(1)]);
    outbox.close();
    appendFileSync(join(dir, 'outbox.jsonl'), 'not-json\n');

    expect(() => Outbox.open(dir)).toThrow(
      'outbox journal contains invalid JSON',
    );
  });

  it('quarantine은 실패 저널(failed.jsonl)에 격리하고 재시작 후에도 유지된다', () => {
    const outbox = Outbox.open(dir);
    const bad = makeEvent(9);
    outbox.quarantine([bad], 'rejected', { codes: ['INVALID_PAYLOAD'] });
    outbox.close();

    const lines = readFileSync(join(dir, 'failed.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as {
      reason: string;
      event: EventInput;
    };
    expect(entry.reason).toBe('rejected');
    expect(entry.event.event_id).toBe(bad.event_id);
  });

  it('quarantine은 재시작 후 같은 event_id를 다시 받아도 중복 기록하지 않는다', () => {
    const bad = makeEvent(9);
    const outbox = Outbox.open(dir);
    expect(outbox.quarantine([bad], 'rejected')).toBe(1);
    outbox.close();

    const reopened = Outbox.open(dir);
    expect(reopened.quarantine([bad], 'rejected')).toBe(0);
    expect(reopened.failedCount).toBe(1);
    reopened.close();
    expect(
      readFileSync(join(dir, 'failed.jsonl'), 'utf8').trim().split('\n'),
    ).toHaveLength(1);
  });

  it('실패 저널의 불완전 tail도 truncate한 뒤 다음 격리를 보존한다', () => {
    const outbox = Outbox.open(dir);
    outbox.quarantine([makeEvent(1)], 'rejected');
    outbox.close();
    appendFileSync(join(dir, 'failed.jsonl'), '{"broken":');

    const reopened = Outbox.open(dir);
    reopened.quarantine([makeEvent(2)], 'rejected');
    reopened.close();

    const reopenedAgain = Outbox.open(dir);
    expect(reopenedAgain.failedCount).toBe(2);
    reopenedAgain.close();
  });

  it('확인 완료 구간이 임계치를 넘으면 컴팩션으로 저널을 줄인다 (중간 삭제 없이)', () => {
    const outbox = Outbox.open(dir);
    // 한 건에 ~64KB — 임계치(4MB)를 확실히 넘기기 위한 크기
    const blob = 'x'.repeat(64 * 1024);
    const total = 70;
    for (let i = 0; i < total; i += 1) {
      outbox.appendMany([makeEvent(i, { blob })]);
    }
    const sizeBefore = statSync(join(dir, 'outbox.jsonl')).size;
    expect(sizeBefore).toBeGreaterThan(COMPACT_THRESHOLD_BYTES);

    outbox.confirm(total - 3); // 대부분 확인 → 컴팩션 발동
    const sizeAfter = statSync(join(dir, 'outbox.jsonl')).size;
    expect(sizeAfter).toBeLessThan(sizeBefore / 2);
    expect(outbox.pendingCount).toBe(3);
    expect(outbox.recordedCount).toBe(total);

    // 컴팩션 후에도 append·재기동 정합 유지
    outbox.appendMany([makeEvent(1000)]);
    outbox.close();
    const reopened = Outbox.open(dir);
    expect(reopened.pendingCount).toBe(4);
    // journal line count가 줄어도 독립 누적 카운터는 컴팩션 전 생성 이력을 유지한다.
    expect(reopened.recordedCount).toBe(total + 1);
    reopened.close();
  });

  it('체크포인트가 저널 크기보다 크면(컴팩션 크래시 잔여) 전량 재전송 쪽으로 리셋한다', () => {
    const outbox = Outbox.open(dir);
    outbox.appendMany([makeEvent(1), makeEvent(2)]);
    outbox.confirm(2);
    outbox.close();
    // 저널을 더 작은 내용으로 교체해 "checkpoint > size" 상황을 만든다
    rmSync(join(dir, 'outbox.jsonl'));
    appendFileSync(
      join(dir, 'outbox.jsonl'),
      `${JSON.stringify(makeEvent(3))}\n`,
    );

    const reopened = Outbox.open(dir);
    expect(reopened.pendingCount).toBe(1); // 유실 대신 재전송 (멱등성이 흡수)
    reopened.close();
  });

  it('pending 범위를 넘는 confirm은 체크포인트를 손상시키지 않는다', () => {
    const outbox = Outbox.open(dir);
    outbox.appendMany([makeEvent(1)]);
    expect(() => outbox.confirm(2)).toThrow('invalid outbox confirm count');
    expect(outbox.pendingCount).toBe(1);
    outbox.close();
  });
});
