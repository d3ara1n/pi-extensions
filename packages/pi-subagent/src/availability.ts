/**
 * Situational agent-role availability — the user's runtime OFF switch for
 * subagent roles.
 *
 * Distinct from `agentOverrides[role].disabled` (a permanent settings.json
 * configuration): an availability entry is a *situational* disable with a
 * free-form reason — quota exhausted on the role's model, a task the role is
 * unfit for, provider outage. State persists to ~/.pi/subagent/availability.json
 * so it survives restarts; entries optionally carry a TTL (`off 6h`) after
 * which they lapse automatically.
 *
 * The model is told through the existing `context`-event reminder channel
 * (same mechanism as the background-run inbox): one byte-stable block
 * listing the OFFLINE roles, injected before every provider call. Delegation
 * itself is never blocked — the reminder is information, the model steers
 * itself.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** One disabled entry, keyed by agent role name. */
export interface DisabledEntry {
  /** Free-form user reason ("quota exhausted", "too risky for this task"). */
  reason: string;
  /** ISO timestamp when the entry was created. */
  at: string;
  /** ISO timestamp after which the entry lapses automatically. */
  until?: string;
}

/** Persisted shape of ~/.pi/subagent/availability.json */
export interface AvailabilityState {
  version: 1;
  disabled: Record<string, DisabledEntry>;
}

const EMPTY_STATE: AvailabilityState = { version: 1, disabled: {} };

/** Default state file location, sibling of the history directory. */
export function availabilityFilePath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "subagent", "availability.json");
}

/** True while the entry exists and its TTL (if any) has not lapsed. */
export function isEntryActive(entry: DisabledEntry, now: Date): boolean {
  return entry.until === undefined || new Date(entry.until).getTime() > now.getTime();
}

/**
 * Read the state file, dropping lapsed entries. Unreadable/corrupt files
 * yield an empty state (the next `off` rewrites the file). When lapsed
 * entries were dropped the file is rewritten best-effort.
 */
export function loadAvailability(filePath: string, now: Date = new Date()): AvailabilityState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { ...EMPTY_STATE, disabled: {} };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_STATE, disabled: {} };
  }
  const source = parsed?.disabled;
  if (!source || typeof source !== "object") return { ...EMPTY_STATE, disabled: {} };

  const disabled: Record<string, DisabledEntry> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(source)) {
    const entry = normalizeEntry(value);
    if (!entry) continue;
    if (isEntryActive(entry, now)) disabled[key] = entry;
    else dropped++;
  }
  if (dropped > 0) saveAvailability(filePath, { version: 1, disabled });
  return { version: 1, disabled };
}

function normalizeEntry(value: any): DisabledEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const at = typeof value.at === "string" ? value.at : new Date().toISOString();
  const until = typeof value.until === "string" ? value.until : undefined;
  const reason = typeof value.reason === "string" ? value.reason : "";
  return { reason, at, ...(until !== undefined ? { until } : {}) };
}

/** Persist the state file (0600, best-effort: never let persistence fail a command). */
export function saveAvailability(filePath: string, state: AvailabilityState): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // Best-effort: the reminder reflects in-session state regardless.
  }
}

// ── Command-argument parsing ───────────────────────────────────────────────

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/;

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse a duration token ("30m", "6h", "1.5d") to ms; undefined if not one. */
export function parseDuration(token: string): number | undefined {
  const match = DURATION_RE.exec(token);
  if (!match) return undefined;
  return Number(match[1]) * DURATION_UNITS[match[2]];
}

/**
 * Parse the argument tail of `off`: an optional leading duration token,
 * everything after it is the free-form reason.
 */
export function parseOffArgs(args: string): { durationMs?: number; reason: string } {
  const trimmed = args.trim();
  if (!trimmed) return { durationMs: undefined, reason: "" };
  const spaceIdx = trimmed.indexOf(" ");
  const first = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const durationMs = parseDuration(first);
  if (durationMs === undefined) return { durationMs: undefined, reason: trimmed };
  return { durationMs, reason: rest };
}

// ── Reminder construction ──────────────────────────────────────────────────

/**
 * The model-facing reminder block: which agent roles are OFFLINE. Absolute
 * timestamps only (an injected block must be byte-stable across requests —
 * relative wording like "in 5h" would drift). Deterministic key order.
 * Undefined when everything is online (inject nothing, cache untouched).
 */
export function buildAvailabilityReminder(
  state: AvailabilityState,
  now: Date = new Date(),
): string | undefined {
  const lines: string[] = [];
  for (const key of Object.keys(state.disabled).sort()) {
    const entry = state.disabled[key];
    if (!isEntryActive(entry, now)) continue;
    const reason = entry.reason ? ` — ${entry.reason}` : "";
    const until = entry.until ? ` (until ${entry.until})` : "";
    lines.push(`- ${key}${reason}${until}`);
  }
  if (lines.length === 0) return undefined;
  return [
    `[subagent availability] These subagent roles are currently OFFLINE — do not delegate to them; the user re-enables them with /subagent:avail <role> on:`,
    ...lines,
  ].join("\n");
}
