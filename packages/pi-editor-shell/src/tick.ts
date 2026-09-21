/**
 * Shared low-frequency tick for UI segments that change on their own while
 * the rest of the interface sits idle — the border's idle timer today,
 * periodic re-checks (git state, remote updates, …) tomorrow.
 *
 * One interval serves every subscriber: it is armed by the first subscriber
 * and torn down when the last one leaves or `stop()` is called, so a tick
 * source can never outlive the session that created it. Subscribers run on
 * every tick but coalesce their own work — they should stay cheap until the
 * state they display actually changes.
 */
export type TickCallback = () => void;

const TICK_INTERVAL_MS = 1_000;

export class TickScheduler {
  private readonly callbacks = new Set<TickCallback>();
  private timer?: ReturnType<typeof setInterval>;

  private readonly intervalMs: number;

  constructor(intervalMs: number = TICK_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  /** True while the shared interval is armed. */
  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Register a callback; returns its unsubscribe function. */
  subscribe(fn: TickCallback): () => void {
    this.callbacks.add(fn);
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
    return () => this.unsubscribe(fn);
  }

  unsubscribe(fn: TickCallback): void {
    this.callbacks.delete(fn);
    if (this.callbacks.size === 0) this.stop();
  }

  /** Stop the interval and drop every subscriber — terminal cleanup. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.callbacks.clear();
  }

  /**
   * Fire every subscriber once. The set is copied first so a callback may
   * subscribe or unsubscribe (itself or others) without mutating the
   * iteration.
   *
   * @internal — driven by the interval; tests call it directly so the suite
   * stays deterministic and no real timers are left behind.
   */
  tick(): void {
    for (const fn of [...this.callbacks]) fn();
  }
}
