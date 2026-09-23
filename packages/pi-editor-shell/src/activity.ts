/** Activity indicator state, animation, idle duration, and cache-age coloring. */

export type SpinnerPhase = "thinking" | "outputting" | "toolcall" | "exec";

// Thinking pulses at half tempo; output fills a braille cell; tool calls
// breathe through a shade ramp; tool execution rotates an arc.
const SPINNERS: Record<SpinnerPhase, readonly string[]> = {
  thinking: ["●", "●", "○", "○"],
  outputting: ["⡀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"],
  toolcall: ["░", "▒", "▓", "█", "▓", "▒"],
  exec: ["◜", "◝", "◞", "◟"],
};

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
 * Theme token for the timer text. The timer is information, not an alarm:
 * muted (the shell's secondary tone, same as the cwd display) while fresh —
 * and forever when the model declares no TTL. Amber inside the last tenth
 * of the TTL and red past it indicate estimated cache age.
 *
 * @internal — exported for testing.
 */
export function idleTimerToken(elapsedMs: number | undefined, ttlMs: number | undefined): IdleTimerToken {
  if (ttlMs == null || ttlMs <= 0) return "muted";
  if (elapsedMs == null || !Number.isFinite(elapsedMs)) return "muted";
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
 * Wall-clock anchor for the idle timer: the newest parseable timestamp
 * among conversational entries (`message`, `custom_message`), scanned from
 * the end. Bootstrap and bookkeeping entries (session header, model/config
 * changes, usage, compaction…) do not count — a fresh session already has
 * them with timestamps before any prompt, and anchoring there would show
 * `0m` instead of hiding the timer. Undefined when no conversational entry
 * carries a parseable timestamp — the timer stays unarmed rather than
 * counting from zero on a session where nothing has happened yet.
 *
 * @internal — exported for testing.
 */
export function lastActivityFromEntries(
  entries: readonly { type?: unknown; timestamp?: unknown }[],
): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message" && entry?.type !== "custom_message") continue;
    const ms = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

type ActivityView =
  | { kind: "hidden" }
  | { kind: "busy"; glyph: string }
  | { kind: "idle"; label: string; token: IdleTimerToken };

/**
 * One session-owned clock: 100 ms while busy, 1 s while idle, stopped before
 * the first activity. Editor replacements only read this state.
 * @internal
 */
export class ActivityIndicator {
  private phase: SpinnerPhase | null = null;
  private frameIndex = 0;
  private idleSince: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private intervalMs: number | undefined;
  private paintedKey = "";
  private readonly requestRender: () => void;
  private readonly getTtl: () => number | undefined;

  constructor(
    requestRender: () => void,
    getTtl: () => number | undefined,
    lastActivityAt?: number,
  ) {
    this.requestRender = requestRender;
    this.getTtl = getTtl;
    this.idleSince = lastActivityAt;
    this.setIntervalMs(lastActivityAt == null ? undefined : 1_000);
  }

  /** Repeated phase events preserve both the frame and the animation clock. */
  setPhase(phase: SpinnerPhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.frameIndex = 0;
    this.setIntervalMs(100);
    this.requestRender();
  }

  /** Begin a new idle interval only after the full run has settled. */
  settle(): void {
    if (this.phase === null) return;
    this.phase = null;
    this.idleSince = Date.now();
    this.setIntervalMs(1_000);
    this.requestRender();
  }

  /** Read live state at paint time, including model-dependent TTL colors. */
  read(): ActivityView {
    const view = this.view();
    this.paintedKey = this.key(view);
    return view;
  }

  /** Idempotent session cleanup; no editor owns or disposes this clock. */
  stop(): void {
    this.setIntervalMs(undefined);
  }

  private view(): ActivityView {
    if (this.phase) return { kind: "busy", glyph: SPINNERS[this.phase][this.frameIndex] };
    if (this.idleSince == null) return { kind: "hidden" };
    const elapsed = Date.now() - this.idleSince;
    return {
      kind: "idle",
      label: formatIdleMinutes(elapsed),
      token: idleTimerToken(elapsed, this.getTtl()),
    };
  }

  private key(view: ActivityView): string {
    if (view.kind === "busy") return view.glyph;
    if (view.kind === "idle") return `${view.label}|${view.token}`;
    return "";
  }

  private setIntervalMs(intervalMs: number | undefined): void {
    if (intervalMs === this.intervalMs) return;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.intervalMs = intervalMs;
    if (intervalMs === undefined) return;
    this.timer = setInterval(() => {
      if (this.phase) this.frameIndex = (this.frameIndex + 1) % SPINNERS[this.phase].length;
      if (this.key(this.view()) !== this.paintedKey) this.requestRender();
    }, intervalMs);
  }
}
