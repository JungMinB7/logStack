import { BackpressureLogGate } from '../src/log-gate';

describe('bounded backpressure warning gate', () => {
  it('logs the first occurrence even at clock zero', () => {
    expect(new BackpressureLogGate().shouldLog('pending_limit', 0)).toBe(true);
  });
  it('suppresses the same reason below one second and permits the exact boundary', () => {
    const gate = new BackpressureLogGate();
    expect(gate.shouldLog('pending_limit', 0)).toBe(true);
    for (const ms of [0, 200, 400, 600, 800, 999]) {
      expect(gate.shouldLog('pending_limit', ms)).toBe(false);
    }
    expect(gate.shouldLog('pending_limit', 1000)).toBe(true);
    expect(gate.shouldLog('pending_limit', 1999)).toBe(false);
  });
  it('does not suppress a different finite reason or reset the first reason', () => {
    const gate = new BackpressureLogGate();
    expect(gate.shouldLog('pending_limit', 0)).toBe(true);
    expect(gate.shouldLog('storage_unavailable', 100)).toBe(true);
    expect(gate.shouldLog('pending_limit', 999)).toBe(false);
    expect(gate.shouldLog('storage_unavailable', 1099)).toBe(false);
    expect(gate.shouldLog('storage_unavailable', 1100)).toBe(true);
  });
});
