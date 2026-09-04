import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { CardEditor, type FrameProvider, type SpinnerPhase } from "./card-editor.ts";
import { DEFAULT_CONFIG, loadEditorShellConfig, type EditorShellConfig, type EditorShellIcons } from "./config.ts";
import { calculateResponsePerformance, type ResponsePerformance } from "./tps.ts";

/**
 * pi-editor-shell — Replaces pi's default editor and status bar with a
 * unified rounded-corner shell, embedding status info in the border:
 * model · thinking level on top, context % + cwd on the bottom.
 * Border color follows pi's thinking/bash indicator automatically.
 *
 * Caveat: `setEditorComponent` is a *replacement* API — mutually exclusive
 * with other editor-replacing extensions (border-status-editor,
 * rainbow-editor, modal-editor, …). Disable those when enabling this one.
 */

/** Collapse the user's home directory to `~` for display.
 *  Uses os.homedir() + path.sep so it works across platforms and does not
 *  match sibling dirs that merely share a string prefix with home. */
function formatCwd(cwd: string): string {
  const home = os.homedir();
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + path.sep)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/** Thinking level → its dedicated theme token, so the label tints the same
 *  color pi applies to the border on that level (strongest "linked" feel). */
const THINKING_TOKEN: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
};

/** Context-fill severity by usage ratio — green / amber / red. */
function contextToken(pct: number | null | undefined): ThemeColor {
  if (pct == null) return "muted";
  if (pct >= 80) return "error";
  if (pct >= 50) return "warning";
  return "success";
}

function trimFixed1(n: number): string {
  const text = n.toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimFixed1(tokens / 1_000_000)}M`;
  return `${(tokens / 1_000).toFixed(0)}k`;
}

// ── Built-in icon set (Nerd Font). Users can override any subset via the
//    `editorShell.icons` config — see config.ts. `cache` uses U+26A1, which
//    Nerd Fonts maps `oct-zap` to directly (no dedicated glyph), so it is
//    the same glyph in and out of a Nerd Font terminal.
const DEFAULT_ICONS: EditorShellIcons = {
  model: "\uf4bc", //   oct-cpu
  thinking: "\uf400", //   oct-light_bulb
  context: "\uf49b", //   oct-cache
  cache: "\u26a1", // ⚡  oct-zap (NF maps this codepoint to U+26A1)
  hitRate: "\uf140", //   fa-bullseye（靶心，缓存命中率）
  folder: "\uf07c", //   fa-folder_open
};

/** Minimal inline types to read cache-read totals without importing the
 *  full pi-ai message union tree. */
interface UsageSnap {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: {
    total?: number;
  };
}
interface MsgSnap {
  role: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: UsageSnap;
  stopReason?: string;
}
interface EntrySnap {
  type: string;
  message?: MsgSnap;
  usage?: UsageSnap;
}

/** Sum cache-related usage across all assistant messages on the session.
 *  Returns the same shape as UsageSnap so we can reuse cacheHitRate(). */
function sumSessionUsage(ctx: { sessionManager: { getEntries(): unknown[] } }): UsageSnap {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    const e = entry as EntrySnap;
    if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage) continue;
    input += e.message.usage.input ?? 0;
    cacheRead += e.message.usage.cacheRead ?? 0;
    cacheWrite += e.message.usage.cacheWrite ?? 0;
  }
  return { input, cacheRead, cacheWrite };
}

/** Sum billable usage across the full session, matching pi's built-in footer:
 *  assistant responses, usage-bearing tool results, compactions, and branch
 *  summaries. Providers without configured pricing report zero cost. */
function sumSessionCost(ctx: { sessionManager: { getEntries(): unknown[] } }): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    const e = entry as EntrySnap;
    let usage: UsageSnap | undefined;
    if (e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")) {
      usage = e.message.usage;
    } else if (e.type === "compaction" || e.type === "branch_summary") {
      usage = e.usage;
    }
    const cost = usage?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
  }
  return total;
}

/** Sum cache-read tokens across all assistant messages — session total for
 *  the "(14.0M)" display in the border. Kept separate from sumSessionUsage
 *  to keep the hot path (agent_end) minimal. */
function sumCacheRead(ctx: { sessionManager: { getEntries(): unknown[] } }): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    const e = entry as EntrySnap;
    if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage) continue;
    total += e.message.usage.cacheRead ?? 0;
  }
  return total;
}

/** Usage of the most recent assistant message — drives the per-turn
 *  cacheRead and the hit rate, matching pi's footer (last entry wins). */
function latestAssistantUsage(ctx: { sessionManager: { getEntries(): unknown[] } }): UsageSnap | undefined {
  let latest: UsageSnap | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    const e = entry as EntrySnap;
    if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage) continue;
    latest = e.message.usage;
  }
  return latest;
}

/** Cache hit rate for a single turn.
 *
 *  The `Usage.input` field has different semantics depending on the provider:
 *  - OpenAI/DeepSeek: `input` = fresh non-cached tokens (promptTokens −
 *    cacheRead − cacheWrite). Denominator = input + cacheRead + cacheWrite.
 *  - Anthropic: `input` = total input_tokens (already includes cacheRead +
 *    cacheWrite). Denominator = input alone (otherwise cache is counted twice).
 *
 *  We detect the convention: if `input` can account for both cacheRead and
 *  cacheWrite (input >= cacheRead + cacheWrite), assume it is the total-input
 *  convention (Anthropic). Otherwise assume the fresh-only convention
 *  (OpenAI).  Heuristic, not perfect, but correct for both conventions in
 *  practice; the real fix belongs in pi-ai where Usage is populated.
 *
 *  Returns undefined when there is no usage or no prompt tokens. */
function cacheHitRate(u: UsageSnap | undefined): number | undefined {
  if (!u) return undefined;
  const nonCached = u.input ?? 0;
  const cached = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  // Anthropic convention: input already includes cacheRead + cacheWrite.
  const totalPrompt = nonCached >= cached && cached > 0
    ? nonCached
    : nonCached + cached;
  if (totalPrompt <= 0) return undefined;
  return ((u.cacheRead ?? 0) / totalPrompt) * 100;
}

/** Format a token count for display: 14000000 → "14.0M", 132000 → "132.0k". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1_000) return `${ms.toFixed(0)} ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${trimFixed1(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  if (minutes < 60) return `${minutes}m ${trimFixed1(remainingSeconds)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTps(tps: number): string {
  if (tps < 0.1) return tps.toFixed(3);
  if (tps < 1) return tps.toFixed(2);
  return tps.toFixed(1);
}

// ── Git dirty state (event-driven, not TTL) ───────────────────────
// Refreshed at session_start and after every agent turn (turn_end).
interface GitDirty {
  staged: number;
  unstaged: number;
  untracked: number;
}
let _gitDirty: GitDirty | undefined;

/** Parse `git status --porcelain` output into staged, unstaged, and untracked counts. */
function parseGitPorcelain(stdout: string): GitDirty {
  const lines = stdout.trim();
  if (!lines) return { staged: 0, unstaged: 0, untracked: 0 };

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of lines.split("\n")) {
    if (line.length < 2) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }
    if (x !== " " && x !== "!") staged++;
    if (y !== " " && y !== "!") unstaged++;
  }
  return { staged, unstaged, untracked };
}

/** Run `git status --porcelain` asynchronously so a slow / hanging git never
 *  blocks the event loop (turn_end is the most latency-sensitive moment —
 *  the agent just finished and the user wants to type). Updates `_gitDirty`
 *  and invokes `onDone` once settled so the caller can trigger a re-render.
 *  A 2s guard kills a runaway process. */
function refreshGitDirty(cwd: string, onDone?: () => void): void {
  const child = spawn(
    "git",
    ["--no-optional-locks", "status", "--porcelain"],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  let stdout = "";
  const timer = setTimeout(() => child.kill("SIGTERM"), 2000);

  // spawn emits both 'error' (e.g. git missing → ENOENT) and a subsequent
  // 'close'; guard so onDone fires exactly once.
  let done = false;
  const settle = (ok: boolean, out: string): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    _gitDirty = ok ? parseGitPorcelain(out) : undefined;
    onDone?.();
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk;
  });
  child.on("error", () => settle(false, ""));
  child.on("close", (code) => settle(code === 0, stdout));
}

/** Format dirty state as "+staged ~unstaged *untracked" (leading space), or ""
 *  if clean / unknown — ready to splice into a "(branch…)" segment. */
function gitDirtyDisplay(): string {
  if (!_gitDirty) return "";
  const parts: string[] = [];
  if (_gitDirty.staged > 0) parts.push(`+${_gitDirty.staged}`);
  if (_gitDirty.unstaged > 0) parts.push(`~${_gitDirty.unstaged}`);
  if (_gitDirty.untracked > 0) parts.push(`*${_gitDirty.untracked}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/** Minimal footer-data shape — just enough to read extension status
 *  texts and the current git branch. */
type FooterSnap = {
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getGitBranch(): string | null;
};

export default function (pi: ExtensionAPI) {
  // The factory may run again when pi rebuilds the editor (model switch,
  // reload, …), so always drive whichever instance is current.
  let editor: CardEditor | undefined;
  let config: EditorShellConfig = { ...DEFAULT_CONFIG };
  // Resolved icons for the current session: built-in defaults merged with
  // the user's overrides. Re-computed at session_start.
  let icons: EditorShellIcons = { ...DEFAULT_ICONS };
  // Shared footer-data ref — the provider (running inside CardEditor.render)
  // reads it to resolve pinned status keys to their current text.
  let footerSnap: FooterSnap | undefined;
  // CWD cached from session_start — used by turn_end to refresh git dirty.
  let _cwd = "";
  // cacheRead total + latest-turn usage, refreshed at session_start +
  // agent_end. The render provider reads these instead of re-scanning
  // entries every frame.
  let _cacheTotal = 0;
  let _latestUsage: UsageSnap | undefined;
  // Client-observed timing for the current assistant response. The completed
  // measurement replaces the previous turn even when throughput is unavailable,
  // so the shell never displays stale performance data.
  let _turnStartedAt: number | undefined;
  let _firstVisibleTextAt: number | undefined;
  let _responseEndedAt: number | undefined;
  let _reasoningExpected = false;
  let _sawThinking = false;
  let _latestPerformance: ResponsePerformance | undefined;
  // Full-session billable cost, including tool/summarization usage. Zero means the
  // provider supplied no priced usage, so the border omits the dollar segment.
  let _sessionCost = 0;

  // ── Phase-aware spinner + lifecycle ────────────────────────────
  // Each event asks the editor for a phase; CardEditor.setSpinner is itself
  // a same-phase no-op, so rapid event streams never reset the animation.
  pi.on("turn_start", (_event, ctx) => {
    _turnStartedAt = performance.now();
    _firstVisibleTextAt = undefined;
    _responseEndedAt = undefined;
    _reasoningExpected = Boolean(ctx.model?.reasoning && pi.getThinkingLevel() !== "off");
    _sawThinking = false;
    _latestPerformance = undefined;
    editor?.setSpinner("thinking");
    editor?.requestRender();
  });
  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    _firstVisibleTextAt = undefined;
    _responseEndedAt = undefined;
    _sawThinking = false;
  });
  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    const t = update.type;
    if (t === "text_delta" && update.delta.length > 0) {
      _firstVisibleTextAt ??= performance.now();
    }
    if (t.startsWith("thinking_")) _sawThinking = true;

    let next: SpinnerPhase;
    if (t.startsWith("thinking_")) next = "thinking";
    else if (t.startsWith("text_")) next = "outputting";
    else if (t.startsWith("toolcall_")) next = "toolcall";
    else return;
    editor?.setSpinner(next);
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    _responseEndedAt = performance.now();
    const message = event.message as MsgSnap;
    const hasVisibleText = message.content?.some(
      (part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0,
    ) ?? false;
    // Non-streaming providers expose visible text only when the response completes.
    if (hasVisibleText) _firstVisibleTextAt ??= _responseEndedAt;
  });
  pi.on("tool_execution_start", () => editor?.setSpinner("exec"));
  pi.on("agent_end", (_event, ctx) => {
    // cacheRead totals + latest usage are stable once a turn finishes —
    // recompute here instead of on every render frame.
    _cacheTotal = sumCacheRead(ctx);
    _latestUsage = latestAssistantUsage(ctx);
    _sessionCost = sumSessionCost(ctx);
    editor?.setSpinner(null);
  });
  pi.on("session_shutdown", () => {
    _turnStartedAt = undefined;
    _firstVisibleTextAt = undefined;
    _responseEndedAt = undefined;
    _reasoningExpected = false;
    _sawThinking = false;
    _latestPerformance = undefined;
    _sessionCost = 0;
    editor?.setSpinner(null);
    editor = undefined;
  });
  pi.on("session_compact", (_event, ctx) => {
    _sessionCost = sumSessionCost(ctx);
    editor?.requestRender();
  });
  pi.on("session_tree", (_event, ctx) => {
    _sessionCost = sumSessionCost(ctx);
    editor?.requestRender();
  });

  // Refresh git dirty after every agent turn (tools may have changed files).
  // Async — never blocks the event loop; re-renders once settled.
  pi.on("turn_end", (event) => {
    if (event.message.role === "assistant") {
      const message = event.message as MsgSnap;
      const hasVisibleText = message.content?.some(
        (part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0,
      ) ?? false;
      _latestPerformance = calculateResponsePerformance({
        outputTokens: message.usage?.output,
        reasoningTokens: message.usage?.reasoning,
        reasoningExpected: _reasoningExpected || _sawThinking,
        turnStartedAt: _turnStartedAt,
        firstVisibleTextAt: _firstVisibleTextAt,
        responseEndedAt: _responseEndedAt,
        hasVisibleText,
        hasToolCall: message.content?.some((part) => part.type === "toolCall") ?? false,
        stopReason: message.stopReason,
      });
      _turnStartedAt = undefined;
      _firstVisibleTextAt = undefined;
      _responseEndedAt = undefined;
      _reasoningExpected = false;
      _sawThinking = false;
      editor?.requestRender();
    }
    if (_cwd) refreshGitDirty(_cwd, () => editor?.requestRender());
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    _cwd = ctx.cwd;
    config = loadEditorShellConfig(ctx.cwd);
    icons = { ...DEFAULT_ICONS, ...config.icons };
    _cacheTotal = sumCacheRead(ctx);
    _latestUsage = latestAssistantUsage(ctx);
    _turnStartedAt = undefined;
    _firstVisibleTextAt = undefined;
    _responseEndedAt = undefined;
    _reasoningExpected = false;
    _sawThinking = false;
    _latestPerformance = undefined;
    _sessionCost = sumSessionCost(ctx);
    refreshGitDirty(ctx.cwd, () => editor?.requestRender());

    // Fresh segments on every render — reads live ctx state, so thinking /
    // context % updates show up on the next paint without extra wiring.
    // The border color itself is left to pi (editor.borderColor), matching
    // the default editor's behavior.
    const provider: FrameProvider = () => {
      const theme = ctx.ui.theme;

      // Resolve pinned status keys → already-themed text, " · "-joined.
      const buildPinned = (): string => {
        const keys = config.pinnedStatus;
        if (keys.length === 0 || !footerSnap) return "";
        const all = footerSnap.getExtensionStatuses();
        const texts = keys
          .map((k) => all.get(k))
          .filter((s): s is string => s != null);
        if (texts.length === 0) return "";
        return ` ${texts.map((s) => theme.fg("muted", s)).join(theme.fg("dim", " · "))} `;
      };

      const model = ctx.model
        ? config.modelDisplay === "name"
          ? ctx.model.name
          : `${ctx.model.provider}/${ctx.model.id}`
        : "no model";
      const thinking = pi.getThinkingLevel();
      const thinkingColor = THINKING_TOKEN[thinking] ?? "muted";

      const usage = ctx.getContextUsage();
      const pct = usage?.percent;
      const ctxWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
      const ctxText =
        pct != null && ctxWindow
          ? `${pct.toFixed(1)}%/${formatContextWindow(ctxWindow)}`
          : "?/??";

      // Cache-read tokens — per-turn figure first, session total in parens,
      // then hit rate (pi's "CHxx%" formula). All refreshed at agent_end and
      // read from cache off the hot path.
      // Session hit rate is available via /editor-shell:status.
      const cacheReadNow = _latestUsage?.cacheRead ?? 0;
      const hitRate = cacheHitRate(_latestUsage);
      const cachePart =
        _cacheTotal > 0
          ? `${theme.fg("dim", " · ")}${theme.fg("warning", `${icons.cache} ${formatTokens(cacheReadNow)} (${formatTokens(_cacheTotal)})${hitRate != null ? ` ${icons.hitRate} ${hitRate.toFixed(1)}%` : ""}`)}`
          : "";
      const displayedTps = config.tpsDisplay === "end-to-end"
        ? _latestPerformance?.e2eTps
        : config.tpsDisplay === "generation"
          ? _latestPerformance?.generationTps
          : undefined;
      const tpsLabel = config.tpsDisplay === "end-to-end" ? "e2e" : "gen";
      const tpsPart = displayedTps != null
        ? `${theme.fg("dim", " · ")}${theme.fg("warning", `${formatTps(displayedTps)} ${tpsLabel} t/s`)}`
        : "";
      const costPart =
        _sessionCost > 0
          ? `${theme.fg("dim", " · ")}${theme.fg("warning", `$${_sessionCost.toFixed(3)}`)}`
          : "";

      // Git branch + dirty state — pi's format: ~/Projects (main).
      const cwdText = formatCwd(ctx.cwd);
      const branch = footerSnap?.getGitBranch() ?? null;
      const dirty = branch ? gitDirtyDisplay() : "";
      const cwdDisplay =
        branch && branch !== "detached"
          ? `${icons.folder} ${cwdText} (${branch}${dirty})`
          : `${icons.folder} ${cwdText}`;

      // Model in accent; thinking label in its level token — same hue the
      // border takes on, so switching levels visibly retints both together.
      return {
        topLeft: ` ${theme.fg("accent", `${icons.model} ${model}`)}${theme.fg("dim", " · ")}${theme.fg(thinkingColor, `${icons.thinking} ${thinking}`)} `,
        topRight: buildPinned(),
        // Context in severity color; cwd stays muted so it never competes.
        bottomLeft: ` ${theme.fg(contextToken(pct), `${icons.context} ${ctxText}`)}${cachePart}${tpsPart}${costPart} `,
        bottomRight: theme.fg("muted", ` ${cwdDisplay} `),
      };
    };

    // CardEditor has its own phase-aware spinner — hide pi's built-in working loader.
    ctx.ui.setWorkingVisible(false);

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      // pi may rebuild the editor mid-session (model switch, reload). Stop the
      // previous editor's spinner timer so it can't keep firing requestRender()
      // on a stale tui handle.
      editor?.setSpinner(null);
      editor = new CardEditor(tui, theme, keybindings, provider);
      return editor;
    });

    // Replace pi's built-in footer with an auto-wrapping extension-status
    // line below the shell.  Each status item is atomic — wrapping breaks
    // between items, never mid-word.
    ctx.ui.setFooter((_tui, theme, footerData) => {
      footerSnap = footerData;
      return {
        render(width: number): string[] {
          const pinned = new Set(config.pinnedStatus);
          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .filter(([key]) => !pinned.has(key))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text);
          if (statuses.length === 0) return [];

          const sep = theme.fg("dim", " · ");
          const lines: string[] = [];
          let current = "";
          for (const s of statuses) {
            const candidate = current ? `${current}${sep}${s}` : s;
            if (visibleWidth(candidate) <= width) {
              current = candidate;
            } else {
              if (current) lines.push(current);
              current = s;
            }
          }
          if (current) lines.push(current);
          return lines;
        },
        invalidate() {},
        dispose() {},
      };
    });
  });

  // ── Debug command ──────────────────────────────────────────────
  pi.registerCommand("editor-shell:status", {
    description: "Show editor-shell debug state: status keys, performance, and usage totals",
    handler: async (_args, ctx) => {
      // Refresh git dirty first so the status output reflects the current
      // working tree — the event-driven cache is otherwise only updated at
      // session_start / turn_end (see refreshGitDirty).
      await new Promise<void>((resolve) => refreshGitDirty(ctx.cwd, resolve));
      const lines: string[] = [];

      lines.push("[editor-shell config]");
      lines.push(`  pinnedStatus: [${config.pinnedStatus.join(", ")}]`);
      lines.push(`  modelDisplay: ${config.modelDisplay}`);
      lines.push(`  tpsDisplay: ${config.tpsDisplay}`);

      lines.push("");
      lines.push("[extension statuses]");
      if (footerSnap) {
        const entries = Array.from(footerSnap.getExtensionStatuses().entries());
        if (entries.length === 0) {
          lines.push("  (none)");
        } else {
          const pinned = new Set(config.pinnedStatus);
          for (const [key, text] of entries.sort(([a], [b]) => a.localeCompare(b))) {
            // The pin marker sits after status text, whose embedded reset
            // would wash it to default white — re-wrap it in dim so it stays
            // consistent with the surrounding text. (status text itself
            // keeps its original color by design.)
            const mark = pinned.has(key) ? ctx.ui.theme.fg("dim", " ← pinned") : "";
            lines.push(`  ${key}: ${text}${mark}`);
          }
        }
      } else {
        lines.push("  (footer not initialized)");
      }

      lines.push("");
      lines.push("[cache totals]");
      const sess = sumSessionUsage(ctx);
      lines.push(`  session input: ${formatTokens(sess.input ?? 0)}`);
      lines.push(`  session cacheRead: ${formatTokens(sess.cacheRead ?? 0)}`);
      lines.push(`  session cacheWrite: ${formatTokens(sess.cacheWrite ?? 0)}`);
      const sRate = cacheHitRate(sess);
      lines.push(`  session hit rate: ${sRate != null ? `${sRate.toFixed(1)}%` : "n/a"}`);
      const sessionCost = sumSessionCost(ctx);
      _sessionCost = sessionCost;
      lines.push(`  session cost: ${sessionCost > 0 ? `$${sessionCost.toFixed(3)}` : "n/a"}`);
      const latest = latestAssistantUsage(ctx);
      const now = latest?.cacheRead ?? 0;
      lines.push(`  this turn cacheRead: ${formatTokens(now)}`);
      const hr = cacheHitRate(latest);
      lines.push(`  this turn hit rate: ${hr != null ? `${hr.toFixed(1)}%` : "n/a"}`);

      lines.push("");
      lines.push("[response performance]");
      const perf = _latestPerformance;
      const throughputReason = perf?.throughputUnavailableReason;
      const generationReason = throughputReason ?? perf?.generationUnavailableReason;
      lines.push(`  wait to first visible text: ${formatDuration(perf?.waitMs)}`);
      lines.push(`  total response time: ${formatDuration(perf?.totalMs)}`);
      lines.push(
        `  end-to-end throughput: ${perf?.e2eTps != null ? `${formatTps(perf.e2eTps)} t/s` : `n/a${throughputReason ? ` (${throughputReason})` : ""}`}`,
      );
      lines.push(
        `  generation throughput: ${perf?.generationTps != null ? `${formatTps(perf.generationTps)} t/s` : `n/a${generationReason ? ` (${generationReason})` : ""}`}`,
      );
      lines.push(`  visible output tokens: ${perf?.visibleTokens ?? "n/a"}`);
      const tokenSource = perf?.tokenSource === "provider-output-minus-reasoning"
        ? "provider output minus reasoning"
        : perf?.tokenSource === "provider-output"
          ? "provider output (reasoning not expected)"
          : "n/a";
      lines.push(`  token source: ${tokenSource}`);

      lines.push("");
      lines.push(`[context] cwd: ${ctx.cwd}`);
      const branch = footerSnap?.getGitBranch();
      lines.push(`  git branch: ${branch ?? "(not in repo)"}`);
      if (branch) {
        const dirty = gitDirtyDisplay().trim();
        lines.push(`  git dirty: ${dirty || "clean"}`);
      }
      const m = ctx.model;
      lines.push(`  model: ${m ? `${m.provider}/${m.id}:${pi.getThinkingLevel()}` : "none"}`);

      // Wrap each line in dim explicitly. notify adds its own outer dim
      // layer, but extension status text carries its own color codes that
      // reset the foreground mid-message. Per-line wrapping re-asserts dim
      // at the start of every line, so a status row's reset can't bleed past
      // it: status stays in its original color, everything else reads dim.
      ctx.ui.notify(
        lines.map((l) => ctx.ui.theme.fg("dim", l)).join("\n"),
        "info",
      );
    },
  });
}
