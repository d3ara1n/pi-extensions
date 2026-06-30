import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { CardEditor, type FrameProvider } from "./card-editor";

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
 *  color pi applies to the border on that level (strongest “linked” feel). */
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

// ── Nerd Font icons (private-use-area codepoints, BMP, FontAwesome —
// supported by virtually every patched font). ───────────────────────────
const ICON = {
  model: "\uf4b8", //   mdi-robot
  thinking: "\uf013", //   fa-cog
  context: "\uf108", //   fa-desktop
  cache: "\uf0e7", //   fa-bolt
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
  message?: MsgSnap;
}

function sumCacheRead(ctx: { sessionManager: { getEntries(): unknown[] } }): number | null {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    const msg = (entry as EntrySnap).message;
    if (msg?.role !== "assistant" || !msg.usage) continue;
    total += msg.usage.cacheRead ?? 0;
  }
  return total > 0 ? total : null;
}

/** Format a token count for display: 14000000 → "14.0M", 132000 → "132.0k". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function (pi: ExtensionAPI) {
  // The factory may run again when pi rebuilds the editor (model switch,
  // reload, …), so always drive whichever instance is current.
  let editor: CardEditor | undefined;

  pi.on("agent_start", () => editor?.setWorking(true));
  pi.on("agent_end", () => editor?.setWorking(false));
  pi.on("session_shutdown", () => {
    editor?.setWorking(false);
    editor = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

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

      // Cache-read token count — same data source pi's own footer uses for "R14M".
      const cacheTokens = sumCacheRead(ctx);
      const cacheStr =
        cacheTokens !== null
          ? `  ${theme.fg("accent", ICON.cache)}${theme.fg("muted", formatTokens(cacheTokens))}`
          : "";

      return {
        segments: {
          // Model in accent; thinking label in its level token — same hue the
          // border takes on, so switching levels visibly retints both together.
          topLeft: ` ${theme.fg("accent", `${ICON.model} ${model}`)}${theme.fg("dim", " · ")}${theme.fg(thinkingColor, `${ICON.thinking} ${thinking}`)} `,
          topRight: "",
          // Context in severity color; cwd stays muted so it never competes.
          bottomLeft: ` ${theme.fg(contextToken(pct), `${ICON.context} ${ctxText}`)}${cacheStr} `,
          bottomRight: theme.fg("muted", ` ${ICON.folder} ${formatCwd(ctx.cwd)} `),
        },
      };
    };

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor = new CardEditor(tui, theme, keybindings, provider);
      return editor;
    });
  });
}
