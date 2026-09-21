/**
 * Idle-timer segment math: formatting and cache-age coloring keyed off the
 * model's prompt-cache TTL. Pure functions over injected inputs so tests
 * stay offline and deterministic; the extension threads live state through
 * them at render time.
 */

/** Theme token the timer text takes per state. */
export type IdleTimerToken = "muted" | "warning" | "error";

/** Fraction of the cache TTL at which the timer turns amber. */
const WARN_AT_TTL = 0.9;

/**
 * Whole minutes since the anchor, floored — 4:59 reads as "4m", anything
 * under a minute reads as "0m". Negative or non-finite input clamps to 0.
 *
 * @internal — exported for testing.
 */
export function formatIdleMinutes(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "0m";
  return `${Math.floor(elapsedMs / 60_000)}m`;
}

/**
 * Display label for the idle timer. An empty label hides the entire segment
 * while the agent is active, when there is no idle interval to measure.
 *
 * @internal — exported for testing.
 */
export function formatIdleTimerLabel(elapsedMs: number, agentActive: boolean): string {
  return agentActive ? "" : formatIdleMinutes(elapsedMs);
}

/**
 * Theme token for the timer text. The timer is information, not an alarm:
 * muted (the shell's secondary tone, same as the cwd display) while fresh —
 * and forever when the model declares no TTL, unknown means "assume not
 * expired". Amber inside the last tenth of the TTL and red past it are
 * unknown means "assume not expired"); amber inside the last tenth of the
 * TTL and red past it are the actual indicators.
 *
 * @internal — exported for testing.
 */
export function idleTimerToken(elapsedMs: number, ttlMs: number | undefined): IdleTimerToken {
  if (ttlMs == null || ttlMs <= 0) return "muted";
  if (elapsedMs < ttlMs * WARN_AT_TTL) return "muted";
  return elapsedMs < ttlMs ? "warning" : "error";
}

/**
 * Prompt-cache TTL for the given model and retention tier, in milliseconds.
 * Mirrors pi's own tier choice: `PI_CACHE_RETENTION=long` selects the long
 * tier, everything else (including unset) the short one. Returns undefined
 * when the model declares no lifetime for the tier — the timer then never
 * indicates.
 *
 * @internal — exported for testing.
 */
export function promptCacheTtlMs(
  model: { promptCache?: Partial<Record<"short" | "long", number>> } | undefined,
  retention: string | undefined,
): number | undefined {
  const tier = retention === "long" ? "long" : "short";
  const seconds = model?.promptCache?.[tier];
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Wall-clock anchor for the idle timer: the newest parseable entry
 * timestamp (scanned from the end), falling back to `now` for empty or odd
 * sessions — so a restored session opens with its true idle time already
 * on screen instead of restarting from zero.
 *
 * @internal — exported for testing.
 */
export function lastActivityFromEntries(
  entries: readonly { timestamp?: unknown }[],
  now: number = Date.now(),
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = entries[i]?.timestamp;
    const ms = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return now;
}
