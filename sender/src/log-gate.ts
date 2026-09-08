/** Finite reason vocabulary: event IDs and free-form messages cannot grow this state. */
export type BackpressureReason = 'pending_limit' | 'storage_unavailable';

export class BackpressureLogGate {
  private readonly last: Record<BackpressureReason, number> = {
    pending_limit: -Infinity,
    storage_unavailable: -Infinity,
  };

  shouldLog(reason: BackpressureReason, now = Date.now()): boolean {
    if (now - this.last[reason] < 1_000) return false;
    this.last[reason] = now;
    return true;
  }
}
