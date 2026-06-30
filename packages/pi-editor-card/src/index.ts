import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { CardEditor, type FrameProvider } from "./card-editor";
import { loadEditorCardConfig, type EditorCardConfig } from "./config";

/**
 * pi-editor-card — Card/panel frame around the input editor.
 *
 * Wraps the default input editor in a rounded-corner box and embeds status
 * info in the border: model · thinking level on top, context % + cwd on the
 * bottom. Border color follows pi's thinking/bash indicator automatically.
 *
 * Caveat: `setEditorComponent` is a *replacement* API — mutually exclusive
 * with other editor-replacing extensions (border-status-editor,
 * rainbow-editor, modal-editor, …). Disable those when enabling this one.
 */

/** Collapse $HOME to `~` for display. */
function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
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
  if (pct === null || pct === undefined) return "muted";
  if (pct >= 80) return "error";
  if (pct >= 50) return "warning";
  return "success";
}

// ── Nerd Font icons (Octicons + FontAwesome) ──────────────────────────
const ICON = {
  model: "\uf4bc", //   oct-cpu
  thinking: "\uf400", //   oct-light-bulb
  context: "\uf49b", //   oct-cache
  cache: "\u26a1", // ⚡  oct-zap
  folder: "\uf07c", //   fa-folder
} as const;

/** Sum cache-read tokens across all assistant messages — same source and
 *  same accumulation as pi's own footer (which renders "R14M").
 *  Returns null when there is nothing to measure.
 *  Inline types avoid importing the full pi-ai message union tree. */
interface MsgSnap {
  role: string;
  usage?: { cacheRead?: number };
}
interface EntrySnap {
  type: string;
  message?: MsgSnap;
}

/** Sum cache-read tokens across all assistant messages,
 *  matching pi's own footer filtering (type === "message"). */
function sumCacheRead(ctx: { sessionManager: { getEntries(): unknown[] } }): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    const e = entry as EntrySnap;
    if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage) continue;
    total += e.message.usage.cacheRead ?? 0;
  }
  return total;
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

/** Run `git status --porcelain` and count staged / unstaged files. */
function refreshGitDirty(cwd: string): void {
  try {
    const r = spawnSync(
      "git",
      ["--no-optional-locks", "status", "--porcelain"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    );
    if (r.status !== 0 || r.error) { _gitDirty = undefined; return; }
    const lines = r.stdout.trim();
    if (!lines) { _gitDirty = { staged: 0, unstaged: 0 }; return; }

    let staged = 0;
    let unstaged = 0;
    for (const line of lines.split("\n")) {
      if (line.length < 2) continue;
      const x = line[0];
      const y = line[1];
      if (x !== " " && x !== "?" && x !== "!") staged++;
      if (y !== " ") unstaged++;
    }
    _gitDirty = { staged, unstaged };
  } catch {
    _gitDirty = undefined;
  }
}

/** Format dirty state as pi-style "+2 ~1" string, or "" if clean / unknown. */
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
  let config: EditorCardConfig = { pinnedStatus: [] };
  // Shared footer-data ref — the provider (running inside CardEditor.render)
  // reads it to resolve pinned status keys to their current text.
  let footerSnap: FooterSnap | undefined;
  // CWD cached from session_start — used by turn_end to refresh git dirty.
  let _cwd = "";

  pi.on("agent_start", () => editor?.setWorking(true));
  pi.on("agent_end", () => editor?.setWorking(false));
  pi.on("session_shutdown", () => {
    editor?.setWorking(false);
    editor = undefined;
  });

  // ── Debug command ──────────────────────────────────────────────
  pi.registerCommand("editor-card:status", {
    description: "Show editor-card debug state: status keys, pinned config, cache totals",
    handler: async (_args, ctx) => {
      const lines: string[] = [];

      lines.push("[editor-card config]");
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
            const mark = pinned.has(key) ? " ← pinned" : "";
            lines.push(`  ${key}: ${text}${mark}`);
          }
        }
      } else {
        lines.push("  (footer not initialized)");
      }

      lines.push("");
      lines.push("[cache totals]");
      const tokens = sumCacheRead(ctx);
      lines.push(`  cacheRead: ${tokens > 0 ? formatTokens(tokens) : "0"}`);

      lines.push("");
      const cwd = ctx.cwd;
      lines.push(`[context] cwd: ${cwd}`);
      const branch = footerSnap?.getGitBranch();
      lines.push(`  git branch: ${branch ?? "(not in repo)"}`);
      if (branch) {
        const ds = _gitDirty
          ? `+${_gitDirty.staged} ~${_gitDirty.unstaged}`
          : "(clean)";
        lines.push(`  git dirty: ${ds}`);
      }
      const m = ctx.model;
      lines.push(`  model: ${m ? `${m.provider}/${m.id}` : "none"}`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Refresh git dirty after every agent turn (tools may have changed files).
  pi.on("turn_end", () => {
    if (_cwd) refreshGitDirty(_cwd);
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    _cwd = ctx.cwd;
    config = loadEditorCardConfig(ctx.cwd);
    refreshGitDirty(ctx.cwd);

    // Fresh segments on every render — reads live ctx state, so thinking /
    // context % updates show up on the next paint without extra wiring.
    // The border color itself is left to pi (editor.borderColor), matching
    // the default editor's behavior.
    const provider: FrameProvider = () => {
      const theme = ctx.ui.theme;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
      const thinking = pi.getThinkingLevel();
      const thinkingColor = THINKING_TOKEN[thinking] ?? "muted";

      const usage = ctx.getContextUsage();
      const pct = usage?.percent;
      const ctxWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
      const ctxText =
        pct !== null && pct !== undefined && ctxWindow
          ? `${Math.round(pct)}%/${(ctxWindow / 1000).toFixed(0)}k`
          : "?/??k";

      // Cache-read token total — same data source pi's own footer uses for "R14M".
      const cacheTokens = sumCacheRead(ctx);
      const cachePart =
        cacheTokens > 0
          ? `${theme.fg("dim", " · ")}${theme.fg("warning", `${ICON.cache} ${formatTokens(cacheTokens)}`)}`
          : "";

      // Git branch + dirty state — pi's format: ~/Projects (main).
      const cwdText = formatCwd(ctx.cwd);
      const branch = footerSnap?.getGitBranch() ?? null;
      const dirty = branch ? gitDirtyDisplay() : "";
      const cwdDisplay =
        branch && branch !== "detached"
          ? `${ICON.folder} ${cwdText} (${branch}${dirty})`
          : `${ICON.folder} ${cwdText}`;

      return {
        segments: {
          // Model in accent; thinking label in its level token — same hue the
          // border takes on, so switching levels visibly retints both together.
          topLeft: ` ${theme.fg("accent", `${ICON.model} ${model}`)}${theme.fg("dim", " · ")}${theme.fg(thinkingColor, `${ICON.thinking} ${thinking}`)} `,
          topRight: buildPinned(theme),
          // Context in severity color; cwd stays muted so it never competes.
          bottomLeft: ` ${theme.fg(contextToken(pct), `${ICON.context} ${ctxText}`)}${cachePart} `,
          bottomRight: theme.fg("muted", ` ${cwdDisplay} `),
        },
      };

      /** Resolve pinned status keys → already-themed text, " · "-joined. */
      function buildPinned(theme: typeof ctx.ui.theme): string {
        const keys = config.pinnedStatus;
        if (keys.length === 0 || !footerSnap) return "";
        const all = footerSnap.getExtensionStatuses();
        const texts = keys
          .map((k) => all.get(k))
          .filter((s): s is string => s != null);
        if (texts.length === 0) return "";
        return ` ${texts.map((s) => theme.fg("muted", s)).join(theme.fg("dim", " · "))} `;
      }
    };

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor = new CardEditor(tui, theme, keybindings, provider);
      return editor;
    });

    // Replace pi's built-in footer with an auto-wrapping extension-status
    // line below the card.  Each status item is atomic — wrapping breaks
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
}
