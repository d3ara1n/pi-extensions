/**
 * Pure helpers for pi-subagent: formatting, sanitization, the concurrency
 * semaphore, render-side timers, and notification throttling. No pi-API or
 * I/O dependencies — safe to unit-test.
 */

import * as os from "node:os";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  ActivityEntry,
  CompletionNoticeDetails,
  FallbackFrom,
  RunState,
  SubagentDetails,
  SubagentRole,
  SubagentResult,
  SubagentUsage,
  ToolStatus,
  WaitDetails,
} from "./types.ts";

/** Max output chars fed to the main model and the expanded TUI. Larger outputs are compressed (or truncated) to fit. */
export const MAX_OUTPUT_CHARS = 50_000;

/** Coalesce bursty progress events so the TUI repaints at most this often. */
export const PROGRESS_THROTTLE_MS = 50;

/** A zeroed usage block — frames and synthesized failures start from this. */
export function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/** Safe TUI label for inherited-conversation input; never includes transcript text. */
export function formatInheritedConversationInput(chars: number, truncated: boolean): string {
  if (chars === 0) return "conversation inherited · empty";
  return `conversation ${chars} chars${truncated ? " · truncated" : ""}`;
}

/**
 * Usage parts for the TUI stats line. `withCache` adds the
 * cache-read/write and peak-context figures (TUI only).
 */
function usageParts(usage: SubagentUsage, model: string | undefined, withCache: boolean): string[] {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`\u2191${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`\u2193${formatTokens(usage.output)}`);
  if (withCache) {
    if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
    if (usage.contextTokens) parts.push(`ctx${formatTokens(usage.contextTokens)}`);
  }
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts;
}
/**
 * Usage-stat segments for every LLM-facing run line: turns, elapsed,
 * tokens, cost — model last when requested. Empty segments are omitted; an
 * empty array means nothing measurable ran. `withElapsed` is off where
 * elapsed already lives elsewhere in the same view (check's running head
 * shows it as `42s/900s` next to the activity).
 */
function statsParts(
  r: { usage: SubagentUsage; exitCode: number; startTime?: number; elapsedMs?: number },
  opts: { withElapsed?: boolean; model?: string } = {},
): string[] {
  const parts: string[] = [];
  if (r.usage.turns) parts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
  if (opts.withElapsed) {
    const secs = elapsedSeconds(r);
    if (secs != null && secs > 0) parts.push(`~${secs}s`);
  }
  if (r.usage.input) parts.push(`↑${formatTokens(r.usage.input)}`);
  if (r.usage.output) parts.push(`↓${formatTokens(r.usage.output)}`);
  if (r.usage.cost) parts.push(`$${r.usage.cost.toFixed(4)}`);
  // The model is an annotation on the stats, never a stat itself — skip it
  // when nothing measurable ran.
  if (opts.model && parts.length > 0) parts.push(opts.model);
  return parts;
}

export function formatUsageStats(usage: SubagentUsage, model?: string): string {
  return usageParts(usage, model, true).join(" ");
}

/**
 * Display elapsed time in seconds.
 * - Running (exitCode === -1 with startTime): live wall-clock value.
 * - Terminal (exitCode !== -1 with elapsedMs): frozen value.
 * - Queued or fields missing: undefined (caller should skip the elapsed display).
 *
 * Takes a structural subset rather than the full SubagentResult so it can be reused
 * and tested in pure-helper contexts without importing the full type.
 */
export function elapsedSeconds(r: {
  exitCode: number;
  startTime?: number;
  elapsedMs?: number;
}): number | undefined {
  if (r.exitCode === -1 && typeof r.startTime === "number") {
    return Math.max(0, Math.round((Date.now() - r.startTime) / 1000));
  }
  if (r.exitCode !== -1 && typeof r.elapsedMs === "number") {
    return Math.round(r.elapsedMs / 1000);
  }
  return undefined;
}

/**
 * Elapsed/budget time text for a frame: `42s/900s(+7s)` while budgeted (grace
 * = time the child spent inside nested delegates, live-computed from an open
 * pause), `42s` without a budget. null when no time is known (queued frames).
 */
export function formatTimePart(r: {
  exitCode: number;
  startTime?: number;
  elapsedMs?: number;
  budgetMs?: number;
  graceMs?: number;
  pauseStart?: number;
}): string | null {
  const secs = elapsedSeconds(r);
  if (secs == null) return null;
  const budgetSec = r.budgetMs ? Math.round(r.budgetMs / 1000) : 0;
  const liveGraceMs = (r.graceMs ?? 0) + (r.pauseStart ? Date.now() - r.pauseStart : 0);
  const graceSec = Math.round(liveGraceMs / 1000);
  return budgetSec > 0
    ? graceSec > 0
      ? `${secs}s/${budgetSec}s(+${graceSec}s)`
      : `${secs}s/${budgetSec}s`
    : `${secs}s`;
}

export type DisplayItem =
  | { type: "toolCall"; name: string; args: Record<string, any>; status?: ToolStatus }
  | { type: "thinking"; status?: ToolStatus };

/**
 * Map the real-time activity log into renderable display items (in order).
 * Streamed-text entries are excluded — they are the :view overlay's exclusive
 * content; the inline tool rows stay as they were.
 */
export function buildDisplayItems(activityLog: ActivityEntry[]): DisplayItem[] {
  return activityLog
    .filter((a) => a.kind === "thinking" || a.kind === "toolCall")
    .map((a) =>
      a.kind === "thinking"
        ? { type: "thinking", status: a.status }
        : { type: "toolCall", name: a.toolName ?? "?", args: a.args ?? {}, status: a.status },
    );
}

export function shortenPath(p: string): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    return p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
  }
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Flatten embedded newlines (multi-line bash commands, patterns, error
 *  messages) into single spaces so a row never spans multiple terminal lines.
 *  Every caller renders the result as ONE TUI row — inline rows join it with
 *  "\n" separators and the :view overlay wraps each row in a border frame. */
function oneLine(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, " ");
}

/**
 * One-line tool-call row for TUI display. Newline sanitization happens here
 * at the single choke point so every tool branch is covered.
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  fg: (color: string, text: string) => string,
): string {
  return oneLine(renderToolCall(toolName, args, fg));
}

function renderToolCall(
  toolName: string,
  args: Record<string, unknown>,
  fg: (color: string, text: string) => string,
): string {
  switch (toolName) {
    case "subagent_delegate": {
      const subRole = args.role as string | undefined;
      // Compact display label — the full tool name is subagent_delegate.
      return fg("muted", "delegate ") + fg("accent", subRole ?? "...");
    }
    case "bash": {
      const command = (args.command as string) || "...";
      return fg("muted", "$ ") + fg("toolOutput", command);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = fg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return fg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = fg("muted", "write ") + fg("accent", shortenPath(rawPath));
      if (lines > 1) text += fg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        fg("muted", "grep ") +
        fg("accent", `/${pattern}/`) +
        fg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      return fg("muted", "find ") + fg("accent", pattern);
    }
    case "glob": {
      const pattern = (args.pattern || "*") as string;
      return fg("muted", "glob ") + fg("accent", pattern);
    }
    default: {
      const preview = previewArgs(args);
      return fg("accent", toolName) + (preview ? fg("dim", ` ${preview}`) : "");
    }
  }
}

/** Per-tool-call visual styling: prefix glyph + color function keyed by status. */
export function statusStyle(
  status: ToolStatus | undefined,
  fg: (color: string, text: string) => string,
): { prefix: string; color: (c: string, text: string) => string } {
  switch (status) {
    case "running":
      return { prefix: fg("accent", "\u2192 "), color: fg };
    case "failed":
      return { prefix: fg("error", "\u2717 "), color: (_c, text) => fg("error", text) };
    case "done":
    default:
      return { prefix: fg("dim", "\u2022 "), color: (_c, text) => fg("dim", text) };
  }
}

/** Render a thinking-block row: diamond glyph + label, colored by status.
 * Running = hollow diamond (unformed thought); done = solid diamond (settled). */
export function formatThinking(
  status: ToolStatus | undefined,
  fg: (color: string, text: string) => string,
): string {
  if (status === "running") {
    return fg("accent", "\u25C7 thinking");
  }
  // done (or unknown) — dim past tense, solid diamond
  return fg("dim", "\u25C6 thought");
}

export function renderDisplayItems(
  items: DisplayItem[],
  limit: number | undefined,
  fg: (color: string, text: string) => string,
): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) text += fg("muted", `... ${skipped} earlier items\n`);
  for (const item of toShow) {
    if (item.type === "thinking") {
      text += `${formatThinking(item.status, fg)}\n`;
    } else {
      const { prefix, color } = statusStyle(item.status, fg);
      text += `${prefix}${formatToolCall(item.name, item.args, color)}\n`;
    }
  }
  return text.trimEnd();
}

// ── Brief page (subagent:view detail view) ─────────────────────

/** Collect string values from a tool call's args, up to a small nesting depth. */
function argStrings(args: Record<string, any> | undefined): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (typeof v === "string") {
      out.push(v);
    } else if (depth > 0 && Array.isArray(v)) {
      for (const item of v) walk(item, depth - 1);
    } else if (depth > 0 && v && typeof v === "object") {
      for (const item of Object.values(v)) walk(item, depth - 1);
    }
  };
  walk(args, 3);
  return out;
}

/** Arg values shorter than this (and without a separator) are ignored as path candidates. */
const PATH_MATCH_MIN = 5;

/**
 * Cross-annotation for the brief page's file list: for each delegate
 * reference file, did any tool call in the activity log touch it? Heuristic
 * string match — a hit is either an arg containing the full path (absolute
 * use, bash references) or the file path ending with the arg (the child
 * using a relative form). Short separator-less values never match, so plain
 * query strings cannot false-positive.
 */
export function briefFilesUsed(
  files: string[] | undefined,
  activityLog: ActivityEntry[],
): Map<string, boolean> {
  const used = new Map<string, boolean>((files ?? []).map((f) => [f, false]));
  if (used.size === 0) return used;
  for (const entry of activityLog) {
    if (entry.kind !== "toolCall") continue;
    for (const v of argStrings(entry.args)) {
      if (v.length < PATH_MATCH_MIN) continue;
      for (const [file, hit] of used) {
        if (hit) continue;
        if (v.includes(file) || (v.includes("/") && file.endsWith(v))) {
          used.set(file, true);
        }
      }
    }
  }
  return used;
}

// ── Shared result-view composition ─────────────────────────────
// Used by the foreground delegate row (./render.ts) and the background
// wait/check rows (./render-async.ts) so every view renders the same
// outcome the same way.

/** Plain-text fallback when details are missing (thrown errors, malformed results). */
export function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  const text = result.content[0];
  return text?.type === "text" && text.text ? text.text : "(no output)";
}

/** First line of the task, truncated to one row (the always-visible anchor). */
export function taskPreview(task: string): string {
  const firstLine = task.split("\n")[0];
  return firstLine.length > 70 ? `${firstLine.slice(0, 70)}...` : firstLine;
}

/**
 * Lines of the background-run completion notice. Bracket label + id/role +
 * outcome on the header line, the bare task preview beneath (dim). Pure
 * notification: the result itself never appears here — it surfaces through
 * subagent_check (model) or /subagent:status (user). The renderer truncates
 * each line to the terminal width independently, so the header never falls
 * off the right edge.
 *
 * Visual family: the [compaction] system-notice card (bracket label, purple
 * box), deliberately NOT the tool-row family — no tool-title prefix, no
 * status icons. Signals "system event", not model behavior.
 */
export function completionNoticeLines(
  details: CompletionNoticeDetails,
  fg: (color: string, text: string) => string,
  bold: (text: string) => string,
): string[] {
  // Intentional stops keep the plain text color; only real failures go red
  // (cancelled keeps warning yellow, mirroring result-line semantics).
  const outcomeColor =
    details.outcome === "failed" ? "error" : details.outcome === "cancelled" ? "warning" : "customMessageText";
  const header =
    fg("customMessageLabel", bold("[subagent]")) +
    ` ${fg("customMessageText", `${details.id} (${details.role})`)} ` +
    fg(outcomeColor, details.outcome);

  const lines = [header];
  const task = oneLine(details.task ?? "").trim();
  if (task) {
    lines.push(fg("dim", task));
  }
  return lines;
}

/**
 * Width-aware collapsed-view component: renders each line truncated with "…"
 * to the actual viewport width (never wraps), padded full-width like Text(0,0).
 *
 * Content formatters leave tool-call arguments intact; this component is the
 * TUI-side final guard, applied where the folding affordance exists.
 */
export function collapsedText(text: string): Component {
  const lines = text.split("\n");
  return {
    render: (width: number) => lines.map((ln) => truncateToWidth(ln, width, "…", true)),
    invalidate: () => {},
  };
}

/** Status icon for a run frame: ⏸ queued / ⏳ running / ⏱ timeout / ⏲ budget / ✗ failed / ✓ ok */
export function runIcon(
  r: { exitCode: number; queued?: boolean; stopReason?: string },
  fg: (color: string, text: string) => string,
): string {
  const state = deriveRunState(r);
  if (state === "queued") return fg("warning", "\u23F8");
  if (state === "running") return fg("warning", "\u23F3");
  if (r.stopReason === "timeout") return fg("warning", "\u23F1");
  if (r.stopReason === "budget_exceeded") return fg("warning", "\u23F2");
  if (r.stopReason === "cancelled") return fg("warning", "\u23F9");
  if (state === "failed") return fg("error", "\u2717");
  return fg("success", "\u2713");
}

/** Failure result-line content: errorMessage → stop-reason label → "failed". */
function failureResultText(r: {
  errorMessage?: string;
  stopReason?: string;
}): { content: string; col: "warning" | "error" } {
  const isTimeout = r.stopReason === "timeout";
  const isBudget = r.stopReason === "budget_exceeded";
  const isCancelled = r.stopReason === "cancelled";
  return {
    content:
      oneLine(r.errorMessage || "") ||
      (isTimeout ? "Timed out" : isBudget ? "Budget exceeded" : isCancelled ? "Cancelled" : "failed"),
    // Timeout/budget/cancel are intentional stops with partial output —
    // warning, not the error red reserved for real failures.
    col: isTimeout || isBudget || isCancelled ? "warning" : "error",
  };
}

/** Success result-line content: AI summary → output first line → placeholder. */
function successResultText(r: {
  summary?: string;
  output: string;
}): { content: string; col: "text" | "muted" } {
  const firstLine = r.output.trim().split("\n")[0] ?? "";
  const preview = firstLine.length > 70 ? `${firstLine.slice(0, 70)}...` : firstLine;
  const content = r.summary || preview;
  return { content: content || "(no output)", col: content ? "text" : "muted" };
}

/**
 * Composed terminal result line `<icon> <content>`. Budget stops count as the
 * failure presentation (their output is partial and the reason matters), even
 * though the run state itself is "finished". `finishedText` (wait's
 * "finished") replaces the success chain for status-only views.
 */
export function terminalResultLine(
  r: {
    exitCode: number;
    queued?: boolean;
    stopReason?: string;
    errorMessage?: string;
    summary?: string;
    output: string;
  },
  fg: (color: string, text: string) => string,
  finishedText?: string,
): string {
  const icon = runIcon(r, fg);
  if (isFailedResult(r) || r.stopReason === "budget_exceeded") {
    const t = failureResultText(r);
    return `${icon} ${fg(t.col, t.content)}`;
  }
  if (finishedText !== undefined) return `${icon} ${fg("text", finishedText)}`;
  const t = successResultText(r);
  return `${icon} ${fg(t.col, t.content)}`;
}

// ── Render-side elapsed-time animation ─────────────────────────

/** Per-row render state slot holding the elapsed-time animation timer. */
interface ElapsedTimerState {
  elapsedTimer?: ReturnType<typeof setInterval>;
}

/**
 * While a run is live, force a TUI repaint every second so the elapsed time
 * ticks up even when the child process is idle. Uses context.invalidate()
 * (pi's official re-render hook) rather than pushing data via onUpdate — the
 * render recomputes elapsed time fresh from Date.now().
 */
export function ensureElapsedTimer(context: {
  state: Record<string, unknown>;
  invalidate?: () => void;
}): void {
  const state = context.state as ElapsedTimerState;
  if (state.elapsedTimer) return;
  if (typeof context.invalidate !== "function") return;
  state.elapsedTimer = setInterval(() => {
    try {
      context.invalidate?.();
    } catch {
      /* ignore — invalidate must never break rendering */
    }
  }, 1000);
}

/** Stop the elapsed-time animation once the run reaches a terminal state. */
export function clearElapsedTimer(context: { state: Record<string, unknown> }): void {
  const state = context.state as ElapsedTimerState;
  if (!state.elapsedTimer) return;
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = undefined;
}

export function isFailedResult(r: { exitCode: number; stopReason?: string }): boolean {
  return (
    r.exitCode !== 0 ||
    r.stopReason === "error" ||
    r.stopReason === "aborted" ||
    r.stopReason === "cancelled" ||
    r.stopReason === "timeout"
  );
}

export function hasFailedSubagentResult(details: unknown): boolean {
  const d = details as SubagentDetails | undefined;
  return Array.isArray(d?.results) && d.results.some(isFailedResult);
}

/** Provider-error keywords that make a failed run worth retrying on the fallback role. */
const PROVIDER_ERROR_RE =
  /429|quota|rate.?limit|auth|timeout|exhausted|unavailable|503|server error|temporary|declined|overloaded|econnreset|socket hang up|epipe|network|connection/i;

/** Heuristic: does this result look like a provider-side failure worth retrying on the fallback role? */
export function isProviderError(result: SubagentResult): boolean {
  return PROVIDER_ERROR_RE.test(`${result.stderr || ""}\n${result.errorMessage || ""}`);
}

/** Cap for the stderr tail kept in fallback diagnostics. */
export const FALLBACK_STDERR_TAIL = 400;

const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Best-effort diagnosis from stderr when the child died before any message_end
 * (e.g. 429 on the very first request — model/errorMessage/stopReason all unset).
 * Returns the last stderr line mentioning a provider-error keyword: pi prints
 * the fatal error near exit, so the last match is the most specific.
 */
export function extractProviderReason(text: string): string | undefined {
  const lines = text
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROVIDER_ERROR_RE.test(lines[i])) return lines[i];
  }
  return undefined;
}

/**
 * Snapshot a failed first attempt for fallback observability.
 * The fallback retry overwrites the result, so this snapshot is the only
 * trace of why the first attempt died. stderr is noisy (TUI teardown
 * escape sequences) — only a truncated tail is kept.
 *
 * `requestedModel` fills the model field when the child died before any
 * message_end — the parent always knows what it asked for.
 */
export function buildFallbackFrom(first: SubagentResult, requestedModel?: string): FallbackFrom {
  const tail = first.stderr.slice(-FALLBACK_STDERR_TAIL).trim();
  return {
    model: first.model ?? requestedModel,
    stopReason: first.stopReason,
    errorMessage: first.errorMessage || extractProviderReason(tail),
    stderrTail: tail || undefined,
  };
}

/**
 * One-line human-readable fallback reason, e.g.
 * `first attempt deepseek-v4-flash failed (Timed out after 900s)`.
 * Prefer errorMessage; fall back to stopReason, else a generic label.
 */
export function formatFallback(f: FallbackFrom): string {
  const reason = f.errorMessage || f.stopReason || "provider error";
  const firstLine = reason.split("\n")[0];
  const short = firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
  return `first attempt ${f.model ?? "unknown model"} failed (${short})`;
}

// ── Background runs (delegate background:true / wait / check) ────────────

/** Derive the lifecycle state of a run from one of its frames (live or terminal). */
export function deriveRunState(r: { exitCode: number; queued?: boolean; stopReason?: string }): RunState {
  if (r.exitCode === -1) return r.queued ? "queued" : "running";
  return isFailedResult(r) ? "failed" : "finished";
}

/** True when wait tool result details carries the timeout flag. */
export function isWaitTimedOut(details: unknown): boolean {
  return (details as WaitDetails | undefined)?.timedOut === true;
}

/** Human-readable description of what a running subagent is doing right now (latest activity item). */
export function describeCurrentActivity(r: { activityLog: ActivityEntry[] }): string {
  const last = r.activityLog[r.activityLog.length - 1];
  if (!last) return "waiting for first event";
  if (last.kind === "thinking") return last.status === "running" ? "thinking" : "thought";
  if (last.kind === "text") return last.status === "running" ? "responding" : "responded";
  if (last.kind === "steer") return "steered — awaiting next turn";
  return formatToolCall(last.toolName ?? "?", last.args ?? {}, (_color, text) => text);
}

/**
 * Terminal-result footer for full views (check, foreground delegate):
 * `\n\n--- 3 turns ~45s ↑12k ↓1k $0.01 model ---` (empty when nothing to show).
 */
export function formatUsageFooter(r: SubagentResult): string {
  const parts = statsParts(r, { withElapsed: true, model: r.model });
  return parts.length > 0 ? `\n\n--- ${parts.join(" ")} ---` : "";
}

/**
 * One-line roll-call status shared by wait's per-run lines and cancel's
 * confirmation: `id (role): state (stats)` — state plus usage stats (turns,
 * elapsed, tokens, cost), nothing else; no output, no model, no notes.
 * check is the complete view.
 */
export function formatRunLine(id: string, role: string, r: SubagentResult): string {
  const state = r.stopReason === "cancelled" ? "cancelled" : deriveRunState(r);
  const head = `${id} (${role}): ${state}`;
  // Queue-time cancels never spawned: nothing measurable ran.
  if (state === "cancelled" && r.elapsedMs == null && !r.usage.turns) {
    return `${head} — never started`;
  }
  const parts = statsParts(r, { withElapsed: true });
  return parts.length > 0 ? `${head} (${parts.join(" ")})` : head;
}

/** Fallback provenance note appended to terminal results (empty when no retry happened). */
export function formatFallbackNote(r: { fallbackFrom?: FallbackFrom; model?: string }): string {
  return r.fallbackFrom
    ? `\n\n--- fallback: ${formatFallback(r.fallbackFrom)}; retried on ${r.model ?? "fallback role"} ---`
    : "";
}

/**
 * Budget-stop note appended to terminal results (empty unless the run was
 * killed for exceeding its turn/cost budget). Budget stops are intentional
 * successes, but the reader must know the output is partial.
 */
export function formatBudgetNote(r: { stopReason?: string; errorMessage?: string }): string {
  return r.stopReason === "budget_exceeded"
    ? `\n\n--- ${r.errorMessage || "Budget exceeded"} ---`
    : "";
}

/** LLM-facing text returned by the check tool for one run snapshot. */
export function formatCheckText(id: string, role: string, r: SubagentResult): string {
  const state = deriveRunState(r);
  const head = `${id} (${role})`;
  if (state === "queued") return `${head}: queued — waiting for a concurrency slot.`;
  if (state === "running") {
    // Elapsed/budget live in the head next to the activity (`42s/900s`); the
    // footer carries turns/tokens/cost so elapsed is never shown twice.
    const time = formatTimePart(r);
    const parts = statsParts(r, { model: r.model });
    return (
      `${head}: running — ${describeCurrentActivity(r)}${time ? ` (${time})` : ""}` +
      (parts.length > 0 ? `\n\n--- ${parts.join(" ")} ---` : "")
    );
  }
  if (r.stopReason === "cancelled") {
    // errorMessage is the bare abort reason ("user: ..." / "session shutdown")
    // — the "cancelled" prefix here is the only wrapper it gets.
    if (r.elapsedMs == null && !r.usage.turns) return `${head}: cancelled — never started`;
    return (
      `${head}: cancelled — ${r.errorMessage || "no reason recorded"}\n\nPartial output:\n${r.output}` +
      formatFallbackNote(r) +
      formatUsageFooter(r)
    );
  }
  if (state === "failed") {
    return (
      `${head}: failed — ${r.errorMessage || r.stderr || "unknown error"}\n\nPartial output:\n${r.output}` +
      formatFallbackNote(r) +
      formatUsageFooter(r)
    );
  }
  return `${head}: finished\n\n${r.output}${formatBudgetNote(r)}${formatFallbackNote(r)}${formatUsageFooter(r)}`;
}

/**
 * Compact stop summary for the cancel TUI row: `cancelled after 3 turns
 * (~45s)` / `cancelled after under a turn (~2s)` / `cancelled — never
 * started` (never spawned: no elapsedMs on the frame).
 */
export function cancelStopSummary(r: SubagentResult): string {
  if (r.elapsedMs == null) return "cancelled — never started";
  const turns = r.usage.turns;
  const secs = Math.max(1, Math.round(r.elapsedMs / 1000));
  const turnNote = turns > 0 ? `${turns} turn${turns === 1 ? "" : "s"}` : "under a turn";
  return `cancelled after ${turnNote} (~${secs}s)`;
}

/**
 * Cancel confirmation: the same roll-call line wait uses (state + usage
 * stats) plus a pointer to check — cancel never dumps the partial output
 * itself (layer contract: cancel intervenes, check fetches).
 */
export function formatCancelText(id: string, role: string, r: SubagentResult): string {
  const line = formatRunLine(id, role, r);
  return r.usage.turns > 0 || r.output.length > 0
    ? `${line} — partial output kept; subagent_check(${id}) returns it.`
    : line;
}

/** Freeze a live frame into a static snapshot: stop the elapsed clock and fold the open pause into grace. */
export function freezeFrame(r: SubagentResult): SubagentResult {
  return {
    ...r,
    startTime: undefined,
    elapsedMs: r.startTime ? Date.now() - r.startTime : r.elapsedMs,
    graceMs: (r.graceMs ?? 0) + (r.pauseStart ? Date.now() - r.pauseStart : 0),
    pauseStart: undefined,
  };
}

/**
 * Shape-based preview for tools we don't have a dedicated formatter for.
 * @internal — exported for testing; used internally by {@link formatToolCall}.
 */
export function previewArgs(args: Record<string, unknown>): string {
  const command = args.command as string | undefined;
  if (command) return `$ ${command}`;
  const fp = (args.file_path || args.path) as string | undefined;
  if (fp) return shortenPath(fp);
  const url = args.url as string | undefined;
  if (url) return url;
  const query = (args.query || args.pattern || args.regex || args.search) as string | undefined;
  if (query) return `/${query}/`;
  return JSON.stringify(args);
}

// ── Numeric configuration ─────────────────────────────────────

/** Normalize a finite numeric limit: invalid values use the default; negatives become 0 (unlimited). */
export function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

/** Normalize a count limit to a non-negative integer. */
export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  return Math.floor(normalizeNonNegativeNumber(value, fallback));
}

// ── Concurrency gate ───────────────────────────────────────────────

/**
 * Promise-based semaphore capping concurrent subagent spawns.
 * A max of 0 means unlimited concurrency, so acquire() never queues.
 * Pass an AbortSignal to cancel while waiting (rejects and removes the waiter).
 */
export class AsyncSemaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  private max: number;
  constructor(max: number) {
    this.max = normalizeNonNegativeInteger(max, 0);
  }
  get isLimited(): boolean {
    return this.max > 0;
  }
  get isAtCapacity(): boolean {
    return this.isLimited && this.active >= this.max;
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    if (!this.isAtCapacity) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const wakeup = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        const idx = this.waiters.indexOf(wakeup);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error("aborted while waiting for concurrency slot"));
      };
      this.waiters.push(wakeup);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  release(): void {
    this.active = Math.max(0, this.active - 1);
    if (!this.isLimited) return;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ── Notification throttling ─────────────────────────────────────

/**
 * Coalesce bursty notifications into at most one `fire` per
 * {@link PROGRESS_THROTTLE_MS}. `cancel()` drops any pending fire — call it
 * when the owning tool call exits, so a stale update never fires afterwards.
 */
export function createThrottler(fire: () => void): { notify(): void; cancel(): void } {
  let pending = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  return {
    notify() {
      pending = true;
      if (handle !== undefined) return;
      handle = setTimeout(() => {
        handle = undefined;
        if (pending) {
          pending = false;
          fire();
        }
      }, PROGRESS_THROTTLE_MS);
    },
    cancel() {
      if (handle !== undefined) clearTimeout(handle);
      handle = undefined;
      pending = false;
    },
  };
}

// ── Timeout policy ────────────────────────────────────────

/**
 * Effective per-role timeout in SECONDS (convert to ms at the spawn boundary).
 * `0` or unset means unlimited; non-finite and negative values normalize to 0.
 */
export function effectiveTimeout(roleDef: SubagentRole): number {
  return normalizeNonNegativeNumber(roleDef.timeout, 0);
}

// ── Output truncation ────────────────────────────────────────

/** Strip path separators / traversal so sessionId/toolCallId can't escape the history dir. */
export function sanitizeFilename(s: string): string {
  return s.replace(/[^\w.-]/g, "_").replace(/^[.]+/, "") || "unknown";
}

/** Mechanical fallback: keep head (findings) + tail (summary), drop the middle. */
export function truncateOutput(t: string): string {
  const head = t.slice(0, 30_000);
  const tail = t.slice(-(MAX_OUTPUT_CHARS - 30_050));
  return `[Output truncated — ${t.length} chars total]\n\n${head}\n\n... [truncated] ...\n\n${tail}`;
}

// ── Session-tree delivery derivation ────────────────────────

/**
 * Minimal structural slice of a session entry — the only fields
 * collectDeliveredIds reads. The real SessionEntry from
 * ctx.sessionManager.buildContextEntries() satisfies this shape structurally;
 * keeping it local preserves this module's zero pi-API-dependency rule and
 * lets tests build plain fakes.
 */
interface SessionEntryLike {
  type: string;
  message?: {
    role?: string;
    toolName?: string;
    details?: unknown;
  };
}

/**
 * Derive the set of background-run ids already delivered by subagent_check
 * on the given session entries. The session tree is the single source of
 * truth for delivery state: it is append-only and branch navigation rebuilds
 * the active path, so branching past a check entry un-delivers (the inbox
 * re-arms) while branching back re-delivers — no mirrored state to sync.
 */
export function collectDeliveredIds(entries: Iterable<SessionEntryLike>): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "toolResult" || message.toolName !== "subagent_check") continue;
    const id = (message.details as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}
