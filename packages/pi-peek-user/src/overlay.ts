/**
 * PeekOverlay — the /peek TUI overlay (LOCAL investigation / "aside").
 *
 * Investigates THIS instance: serialize the main conversation + investigate via
 * the investigation model, read-after-burn. The user inspects their own session
 * without disturbing the main agent.
 *
 * Layout (regions separated by `├───┤` dividers, closed at the bottom with
 * `╰───╯`). `margin:{bottom:2}` in overlayOptions keeps pi's own footer
 * (rendered at the terminal bottom, outside the overlay) visually separate:
 *
 *   ╭──────────────────────────────────────────────────────╮  top border
 *   │ peek (main agent: <activity>, turn N)                │  title
 *   ├──────────────────────────────────────────────────────┤
 *   │ <report region: auto-height, scrollable, streaming>  │
 *   ├──────────────────────────────────────────────────────┤
 *   │ <editor: input or waiting…>                        │  composer
 *   ├──────────────────────────────────────────────────────┤
 *   │ model <utility>                   tokens <n>         │  status
 *   ├──────────────────────────────────────────────────────┤
 *   │ Esc close · ↑↓ scroll · Enter send                   │  hotkeys
 *   ╰──────────────────────────────────────────────────────╯  bottom border
 *
 * Auto-height: the report region grows with content up to a cap derived from
 * the REAL terminal height (read via tui.terminal.rows). Once content exceeds
 * the cap, it scrolls (↑/↓) and auto-follows the tail while streaming.
 */

import {
  type EditorTheme,
  Editor,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  formatInvestigationStatus,
  getPeekAPI,
  type InvestigateResult,
  type MainAgentStatus,
  type PeekAPI,
  type PeekInvestigation,
  type PeekReferenceOptions,
} from "@d3ara1n/pi-peek";
import {
  getMarkdownTheme,
  type ExtensionContext,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";

/** Minimal slice of TUI we use: render trigger + terminal size. */
interface PeekTui {
  requestRender(): void;
  readonly terminal?: {
    readonly rows: number;
    readonly columns: number;
  };
}

interface PeekTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

interface HistoryItem {
  role: "user" | "assistant";
  text: string;
  usage?: InvestigateResult["usage"];
  model?: string;
  markdown?: Markdown;
  notice?: string;
}

type Mode = "input" | "investigating";

/** Rows occupied by everything EXCEPT the report region and composer:
 *  top border(1) + title(1) + 4 dividers(4) + status(1) + hotkeys(1) + bottom border(1) = 9.
 *  Composer rows are added dynamically when the input wraps. */
const FIXED_OVERHEAD_NO_COMPOSER = 9;
/** Composer rows cap so a huge paste doesn't push the report region off-screen. */
const MAX_COMPOSER_LINES = 5;
/** Floor for the report region so tiny terminals still show something. */
const MIN_BODY_ROWS = 4;

export class PeekOverlay {
  private tui: PeekTui;
  private theme: PeekTheme;
  private done: () => void;
  private ctx: ExtensionContext;
  private api: PeekAPI;
  private referenceOptions: PeekReferenceOptions;

  private mode: Mode = "input";
  private editor!: Editor;
  private history: HistoryItem[] = [];

  // investigation state
  private stage = "";
  private investigateStart = 0;
  private streamText = "";
  private markdownTheme = getMarkdownTheme();
  private streamMarkdown = new Markdown("", 0, 0, this.markdownTheme);

  // The investigation owns the full reference and model history; this history is for display.
  private investigation: PeekInvestigation | null = null;
  private requestGeneration = 0;
  private requestAbort: AbortController | null = null;

  // tracker (main agent's current activity, shown in the header)
  private tracker: MainAgentStatus | null = null;
  private trackerTimer: ReturnType<typeof setInterval> | null = null;

  // scroll
  private bodyLines: string[] = [];
  private userMessageAnchors: number[] = [];
  private activeUserAnchorIndex: number | null = null;
  private scrollOffset = 0;
  private autoFollow = true;
  // composer: how many rows the composer occupies (≥1); set during render
  private composerRows = 1;

  // last investigation model used (status line before the first report)
  private lastModel: string | null = null;

  constructor(
    tui: PeekTui,
    theme: PeekTheme,
    done: () => void,
    ctx: ExtensionContext,
    api: PeekAPI = getPeekAPI(),
    referenceOptions: PeekReferenceOptions = {},
  ) {
    this.api = api;
    this.referenceOptions = referenceOptions;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.ctx = ctx;

    // The composer is a real text editor (cursor movement, word delete,
    // undo, word-wrap) — not the old append-only string. Enter fires
    // onSubmit, wired to submit().
    const editorTheme: EditorTheme = {
      borderColor: (s) => this.theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => this.theme.fg("accent", t),
        selectedText: (t) => this.theme.fg("accent", t),
        description: (t) => this.theme.fg("muted", t),
        scrollInfo: (t) => this.theme.fg("dim", t),
        noMatch: (t) => this.theme.fg("warning", t),
      },
    };
    this.editor = new Editor(this.tui as never, editorTheme);
    this.editor.onSubmit = (value) => this.submit(value);
    this.refreshTracker();
    this.trackerTimer = setInterval(() => this.refreshTracker(), 2000);
  }

  private refreshTracker(): void {
    try {
      this.tracker = this.api.getMainAgentStatus();
      this.tui.requestRender();
    } catch {
      // ignore
    }
  }

  /** Real terminal height (falls back to 24 if the TUI doesn't expose it). */
  private get termRows(): number {
    return this.tui.terminal?.rows ?? 24;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    // Scroll and message jumps work in both modes — review history while waiting.
    if (matchesKey(data, "pageUp")) {
      this.jumpToUserMessage("previous");
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.jumpToUserMessage("next");
      return;
    }
    if (matchesKey(data, "up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.activeUserAnchorIndex = null;
      this.autoFollow = false;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      const max = Math.max(0, this.bodyLines.length - this.currentBodyHeight);
      this.scrollOffset = Math.min(max, this.scrollOffset + 1);
      this.activeUserAnchorIndex = null;
      if (this.scrollOffset >= max) this.autoFollow = true;
      this.tui.requestRender();
      return;
    }
    if (this.mode === "investigating") return;
    // The Editor owns all text editing: typed characters, backspace, cursor
    // movement (Left/Right/Home/End, Ctrl+A/E, word moves), undo, and Enter
    // (which fires onSubmit → submit). Up/Down and PageUp/PageDown stay ours
    // for question navigation, so they are NOT forwarded.
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  private jumpToUserMessage(direction: "previous" | "next"): void {
    if (this.userMessageAnchors.length === 0) return;

    const maxOffset = Math.max(0, this.bodyLines.length - this.currentBodyHeight);
    let targetIndex: number | undefined;

    if (direction === "previous") {
      if (this.activeUserAnchorIndex !== null) {
        targetIndex = this.activeUserAnchorIndex - 1;
      } else if (this.scrollOffset >= maxOffset) {
        targetIndex = this.userMessageAnchors.length - 1;
      } else {
        for (let i = this.userMessageAnchors.length - 1; i >= 0; i--) {
          const anchor = this.userMessageAnchors[i];
          if (anchor !== undefined && anchor < this.scrollOffset) {
            targetIndex = i;
            break;
          }
        }
      }
    } else if (this.activeUserAnchorIndex !== null) {
      targetIndex = this.activeUserAnchorIndex + 1;
      if (targetIndex >= this.userMessageAnchors.length) {
        this.activeUserAnchorIndex = null;
        this.scrollOffset = maxOffset;
        this.autoFollow = true;
        this.tui.requestRender();
        return;
      }
    } else {
      if (this.scrollOffset >= maxOffset) return;
      targetIndex = this.userMessageAnchors.findIndex((anchor) => anchor > this.scrollOffset);
      if (targetIndex < 0) {
        this.scrollOffset = maxOffset;
        this.autoFollow = true;
        this.tui.requestRender();
        return;
      }
    }

    if (targetIndex === undefined || targetIndex < 0) return;
    const target = this.userMessageAnchors[targetIndex];
    if (target === undefined) return;

    this.activeUserAnchorIndex = targetIndex;
    this.scrollOffset = Math.min(target, maxOffset);
    this.autoFollow = false;
    this.tui.requestRender();
  }

  private submit(value: string): void {
    const q = value.trim();
    if (!q) return;

    this.mode = "investigating";
    this.stage = "investigating";
    this.investigateStart = Date.now();
    this.streamText = "";
    this.streamMarkdown.setText("");
    this.history.push({ role: "user", text: q });
    this.activeUserAnchorIndex = null;
    this.autoFollow = true;
    this.tui.requestRender();

    const generation = ++this.requestGeneration;
    const requestAbort = new AbortController();
    this.requestAbort = requestAbort;
    Promise.resolve()
      .then(() => {
        if (this.closed) throw new Error("peek: overlay closed.");
        this.investigation ??= this.api.createInvestigation(this.referenceOptions);
        return this.investigation.investigate(q, {
          signal: requestAbort.signal,
          onStage: (s) => {
            if (this.closed || generation !== this.requestGeneration) return;
            this.stage = s;
            this.tui.requestRender();
          },
          onProgress: (progress) => {
            if (this.closed || generation !== this.requestGeneration) return;
            this.stage = progress.stage;
            this.lastModel = progress.model;
            this.tui.requestRender();
          },
          onReset: () => {
            if (this.closed || generation !== this.requestGeneration) return;
            this.streamText = "";
            this.streamMarkdown.setText("");
            this.stage = "investigating";
            this.tui.requestRender();
          },
          onToken: (d) => {
            if (this.closed || generation !== this.requestGeneration) return;
            this.streamText += d;
            this.stage = "outputting";
            this.streamMarkdown.setText(this.streamText);
            this.tui.requestRender();
          },
        });
      })
      .then((result) => {
        if (this.requestAbort === requestAbort) this.requestAbort = null;
        if (this.closed || generation !== this.requestGeneration) return;
        this.history.push({
          role: "assistant",
          text: result.report,
          notice: result.stopReason === "length" ? "Output limit reached" : undefined,
          usage: result.usage,
          model: result.model,
          markdown: new Markdown(result.report, 0, 0, this.markdownTheme),
        });
        if (result.model) this.lastModel = result.model;
        this.mode = "input";
        this.streamText = "";
        this.activeUserAnchorIndex = null;
        this.autoFollow = true;
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.requestAbort === requestAbort) this.requestAbort = null;
        if (this.closed || generation !== this.requestGeneration) return;
        const overflow = err?.code === "context_overflow";
        const msg = err instanceof Error ? err.message : String(err);
        const partial = this.streamText;
        const text = partial || (overflow ? "" : `Error: ${msg}`);
        this.history.push({
          role: "assistant",
          text,
          notice: partial
            ? `Report interrupted: ${overflow ? "Context limit reached" : msg}`
            : overflow
              ? "Context limit reached"
              : undefined,
          markdown: new Markdown(text, 0, 0, this.markdownTheme),
        });
        this.mode = "input";
        this.streamText = "";
        this.activeUserAnchorIndex = null;
        this.autoFollow = true;
        this.tui.requestRender();
      });
  }

  private closed = false;

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.requestGeneration++;
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.investigation?.dispose();
    this.investigation = null;
    this.history = [];
    this.streamText = "";
    this.streamMarkdown.setText("");
    this.bodyLines = [];
    if (this.trackerTimer) {
      clearInterval(this.trackerTimer);
      this.trackerTimer = null;
    }
    this.done();
  }

  dispose(): void {
    this.close();
  }

  invalidate(): void {
    this.streamMarkdown.invalidate();
    for (const item of this.history) item.markdown?.invalidate();
  }

  /**
   * Report region height for the current render.
   * Grows with content up to a cap derived from the real terminal height
   * (matches the `maxHeight: "80%"` in overlayOptions). Content beyond the
   * cap scrolls.
   */
  private get currentBodyHeight(): number {
    const overlayMaxRows = Math.floor(this.termRows * 0.8);
    const overhead = FIXED_OVERHEAD_NO_COMPOSER + this.composerRows;
    const cap = Math.max(MIN_BODY_ROWS, overlayMaxRows - overhead);
    return Math.min(cap, Math.max(MIN_BODY_ROWS, this.bodyLines.length));
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(20, width - 2);
    const b = (c: string) => th.fg("border", c);

    /**
     * Pad/truncate `s` to EXACTLY innerW visible columns, with both borders.
     *
     * This is the fix for the old "right border gets pushed off" bug:
     * truncateToWidth(_, _, "", true) both truncates AND pads to exactly
     * innerW regardless of the input's visible width, so the closing │
     * always lands at column `width-1`.
     */
    const row = (s: string) => b("│") + truncateToWidth(s, innerW, "", true) + b("│");

    const divider = () => b("├") + b("─".repeat(innerW)) + b("┤");

    // ── rebuild body lines (history + live stream) ───────────────────
    // Wrap to innerW - 2 so a leading " " indent + the line fits in innerW.
    this.bodyLines = [];
    this.userMessageAnchors = [];
    const wrapW = Math.max(10, innerW - 2);

    if (this.history.length === 0 && this.mode !== "investigating") {
      // Welcome / placeholder so the body isn't an empty hole on first open.
      const welcome = "Investigate this session.";
      this.bodyLines.push(th.fg("dim", "aside · read-after-burn"));
      for (const ln of wrapTextWithAnsi(th.fg("dim", welcome), wrapW)) {
        this.bodyLines.push(ln);
      }
    } else {
      for (const h of this.history) {
        if (h.role === "user") {
          this.userMessageAnchors.push(this.bodyLines.length);
          const label = " you ";
          const rule = "─".repeat(Math.max(0, wrapW - visibleWidth(label)));
          this.bodyLines.push(th.fg("accent", `${label}${rule}`));
        } else {
          const label = h.notice ? ` peek · ${h.notice} ` : " peek ";
          const rule = "─".repeat(Math.max(0, wrapW - visibleWidth(label)));
          this.bodyLines.push(th.fg(h.notice ? "warning" : "success", `${label}${rule}`));
        }
        if (h.role === "assistant") {
          h.markdown ??= new Markdown(h.text, 0, 0, this.markdownTheme);
          this.bodyLines.push(...h.markdown.render(wrapW));
        } else {
          for (const ln of wrapTextWithAnsi(h.text, wrapW)) {
            this.bodyLines.push(ln);
          }
        }
      }
    }

    if (this.mode === "investigating") {
      const elapsed = ((Date.now() - this.investigateStart) / 1000).toFixed(1);
      const stateText = formatInvestigationStatus(
        this.stage || "investigating",
        this.streamText.length,
      );
      const stateLabel =
        this.stage === "done"
          ? th.fg("success", stateText)
          : this.stage === "error"
            ? th.fg("error", stateText)
            : th.fg("muted", stateText);
      const prefixText = ` peek · ${stateText} ${elapsed}s `;
      const rule = "─".repeat(Math.max(0, wrapW - visibleWidth(prefixText)));
      this.bodyLines.push(
        `${th.fg("success", " peek ")}${th.fg("dim", "· ")}${stateLabel} ${th.fg("dim", `${elapsed}s `)}${th.fg("success", rule)}`,
      );
      // Stream placeholder so the region doesn't look frozen before the
      // first token lands. Once text arrives, render it with pi's Markdown
      // component so partial and completed reports use identical formatting.
      if (this.streamText) {
        this.bodyLines.push(...this.streamMarkdown.render(wrapW));
      } else {
        this.bodyLines.push(th.fg("dim", "…"));
      }
    }

    // ── composer lines (calculated first — body height depends on it) ─
    // The Editor owns the input region: typed text, the cursor (Home/End,
    // Left/Right, word moves, undo), and word-wrap. Its render() frames the
    // text with a top/bottom rule; we slice those off (the surrounding
    // dividers below already frame the region) and cap the row count so a
    // huge paste can't push the report region off-screen. Rendered at
    // innerW-1 with a leading indent space, matching the body rows.
    const composerLines: string[] = [];
    if (this.mode === "investigating") {
      composerLines.push(
        th.fg("muted", ` ${formatInvestigationStatus(this.stage || "investigating")}`),
      );
    } else {
      const editorLines = this.editor.render(innerW - 1).slice(1, -1);
      for (let i = 0; i < editorLines.length && composerLines.length < MAX_COMPOSER_LINES; i++) {
        composerLines.push(` ${editorLines[i]}`);
      }
      if (editorLines.length > MAX_COMPOSER_LINES) {
        composerLines.push(` ${th.fg("dim", "…")}`);
      }
    }
    this.composerRows = composerLines.length;

    // ── scroll clamp + auto-follow ────────────────────────────────────
    const bodyH = this.currentBodyHeight;
    const maxOffset = Math.max(0, this.bodyLines.length - bodyH);
    if (this.autoFollow || this.scrollOffset > maxOffset) {
      this.scrollOffset = maxOffset;
    }

    // ── render ────────────────────────────────────────────────────────
    const out: string[] = [];

    // ── top border (clean — title lives on its own line below) ──────
    out.push(b("╭") + b("─".repeat(innerW)) + b("╮"));

    // ── title row (its own line, padded by row()) ──────────────────
    const title = th.fg("accent", th.bold("peek"));
    let titleInner: string;
    if (this.tracker) {
      const act = this.tracker.activity || "idle";
      const turn = this.tracker.turn > 0 ? `, turn ${this.tracker.turn}` : "";
      titleInner = ` ${title} ${th.fg("dim", `(main agent: ${act}${turn})`)}`;
    } else {
      titleInner = ` ${title} ${th.fg("dim", "(main agent: unknown)")}`;
    }
    out.push(row(titleInner));

    // ── divider separating the title from the content region ────────
    out.push(divider());

    // ── report region: auto-height, scrollable ──────────────────────
    const start = this.scrollOffset;
    const visible = this.bodyLines.slice(start, start + bodyH);
    for (let i = 0; i < bodyH; i++) {
      const ln = visible[i] ?? "";
      // Leading " " indent; row() guarantees exact innerW width.
      out.push(row(` ${ln}`));
    }

    // ── divider + composer (wraps long input across multiple rows) ──
    out.push(divider());
    for (const ln of composerLines) {
      out.push(row(ln));
    }

    // ── divider + status line (investigation model + cumulative tokens) ──
    out.push(divider());
    const modelId = this.lastModel ?? "—";
    const totalTokens = this.history.reduce((sum, h) => sum + (h.usage?.total ?? 0), 0);
    const tokensStr = totalTokens > 0 ? formatTokens(totalTokens) : "—";
    const leftInfo = `${th.fg("muted", "model")} ${th.fg("dim", modelId)}`;
    const rightInfo = `${th.fg("muted", "tokens")} ${th.fg("dim", tokensStr)}`;
    const gap = Math.max(1, innerW - 1 - visibleWidth(leftInfo) - visibleWidth(rightInfo));
    out.push(row(` ${leftInfo}${" ".repeat(gap)}${rightInfo}`));

    // ── divider + hotkeys ───────────────────────────────────────────
    out.push(divider());
    const scrollHint =
      maxOffset > 0
        ? ` ${th.fg("dim", "·")} ${th.fg("dim", `↑${this.scrollOffset} ↓${maxOffset - this.scrollOffset} scroll`)}`
        : "";
    const jumpKeys = "PageUp/Dn jump";
    const hotkeys = ` ${th.fg("dim", "Esc close")}${scrollHint} ${th.fg("dim", "·")} ${th.fg("dim", jumpKeys)} ${th.fg("dim", "·")} ${th.fg("dim", "Enter send")}`;
    out.push(row(hotkeys));

    // ── bottom border: close the box ─────────────────────────────────
    out.push(b("╰") + b("─".repeat(innerW)) + b("╯"));

    return out;
  }
}

/** Compact token count, e.g. 1234 -> "1.2k", 1500000 -> "1.5M". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
