import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { CardEditor, type FrameProvider, type SpinnerPhase } from "./card-editor";
import { loadEditorShellConfig, type EditorShellConfig, type EditorShellIcons } from "./config";

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
  cacheRead?: number;
  cacheWrite?: number;
}
interface MsgSnap {
  role: string;
  usage?: UsageSnap;
}
interface EntrySnap {
  type: string;
  message?: MsgSnap;
}

/** Sum cache-read tokens across all assistant messages, matching pi's own
 *  footer filtering (type === "message") and accumulation ("R14M"). */
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

/** Cache hit rate for a single turn: cacheRead / (input + cacheRead +
 *  cacheWrite) × 100 — same formula pi's footer uses for "CHxx%".
 *  Returns undefined when there's no usage or no prompt tokens. */
function cacheHitRate(u: UsageSnap | undefined): number | undefined {
  if (!u) return undefined;
  const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  if (prompt <= 0) return undefined;
  return ((u.cacheRead ?? 0) / prompt) * 100;
}

/** Format a token count for display: 14000000 → "14.0M", 132000 → "132.0k". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── Git dirty state (event-driven, not TTL) ───────────────────────
// Refreshed at session_start and after every agent turn (turn_end).
interface GitDirty {
  staged: number;
  unstaged: number;
}
let _gitDirty: GitDirty | undefined;

/** Parse `git status --porcelain` output into staged / unstaged counts. */
function parseGitPorcelain(stdout: string): GitDirty {
  const lines = stdout.trim();
  if (!lines) return { staged: 0, unstaged: 0 };

  let staged = 0;
  let unstaged = 0;
  for (const line of lines.split("\n")) {
    if (line.length < 2) continue;
    const x = line[0];
    const y = line[1];
    if (x !== " " && x !== "?" && x !== "!") staged++;
    if (y !== " ") unstaged++;
  }
  return { staged, unstaged };
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

/** Format dirty state as pi-style "+2 ~1" string (leading space), or "" if
 *  clean / unknown — ready to splice into a "(branch…)" segment. */
function gitDirtyDisplay(): string {
  if (!_gitDirty) return "";
  const parts: string[] = [];
  if (_gitDirty.staged > 0) parts.push(`+${_gitDirty.staged}`);
  if (_gitDirty.unstaged > 0) parts.push(`~${_gitDirty.unstaged}`);
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
  let config: EditorShellConfig = { pinnedStatus: [], icons: {} };
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

  // ── Phase-aware spinner + lifecycle ────────────────────────────
  // Each event asks the editor for a phase; CardEditor.setSpinner is itself
  // a same-phase no-op, so rapid event streams never reset the animation.
  pi.on("turn_start", () => editor?.setSpinner("thinking"));
  pi.on("message_update", (event) => {
    const t = event.assistantMessageEvent.type;
    let next: SpinnerPhase;
    if (t.startsWith("thinking_")) next = "thinking";
    else if (t.startsWith("text_")) next = "outputting";
    else if (t.startsWith("toolcall_")) next = "toolcall";
    else return;
    editor?.setSpinner(next);
  });
  pi.on("tool_execution_start", () => editor?.setSpinner("exec"));
  pi.on("agent_end", (_event, ctx) => {
    // cacheRead totals + latest usage are stable once a turn finishes —
    // recompute here instead of on every render frame.
    _cacheTotal = sumCacheRead(ctx);
    _latestUsage = latestAssistantUsage(ctx);
    editor?.setSpinner(null);
  });
  pi.on("session_shutdown", () => {
    editor?.setSpinner(null);
    editor = undefined;
  });

  // Refresh git dirty after every agent turn (tools may have changed files).
  // Async — never blocks the event loop; re-renders once settled.
  pi.on("turn_end", () => {
    if (_cwd) refreshGitDirty(_cwd, () => editor?.requestRender());
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    _cwd = ctx.cwd;
    config = loadEditorShellConfig(ctx.cwd);
    icons = { ...DEFAULT_ICONS, ...config.icons };
    _cacheTotal = sumCacheRead(ctx);
    _latestUsage = latestAssistantUsage(ctx);
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

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
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
      const cacheReadNow = _latestUsage?.cacheRead ?? 0;
      const hitRate = cacheHitRate(_latestUsage);
      const cachePart =
        _cacheTotal > 0
          ? `${theme.fg("dim", " · ")}${theme.fg("warning", `${icons.cache} ${formatTokens(cacheReadNow)} (${formatTokens(_cacheTotal)})${hitRate != null ? ` ${icons.hitRate} ${hitRate.toFixed(1)}%` : ""}`)}`
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
        bottomLeft: ` ${theme.fg(contextToken(pct), `${icons.context} ${ctxText}`)}${cachePart} `,
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
    description: "Show editor-shell debug state: status keys, pinned config, cache totals",
    handler: async (_args, ctx) => {
      const lines: string[] = [];

      lines.push("[editor-shell config]");
      lines.push(`  pinnedStatus: [${config.pinnedStatus.join(", ")}]`);

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
      const tokens = sumCacheRead(ctx);
      lines.push(`  cacheRead (session): ${tokens > 0 ? formatTokens(tokens) : "0"}`);
      const latest = latestAssistantUsage(ctx);
      const now = latest?.cacheRead ?? 0;
      lines.push(`  cacheRead (this turn): ${formatTokens(now)}`);
      const hr = cacheHitRate(latest);
      lines.push(`  hit rate: ${hr != null ? `${hr.toFixed(1)}%` : "n/a"}`);

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
