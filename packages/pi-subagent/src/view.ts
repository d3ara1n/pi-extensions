/**
 * /subagent:view — live activity overlay for subagent runs.
 *
 * Design: a continuous, append-only list. Every entry is static text plus a
 * state bit; the only animated thing is the ellipsis on a running entry's
 * suffix ("." → ".." → "..."). Finishing freezes an entry in place — its
 * position never changes, only the icon flips. Multiple runs stack: one
 * header line per run, entries flowing beneath it; concurrent tool calls are
 * adjacent spinning lines. Streamed assistant text is the single growing
 * element: it renders as the run's last line and freezes at message_end.
 *
 * The focused run has two full-width pages, toggled with `d`:
 *  - activity (default): the live feed, scrollable with ↑/↓/PgUp/PgDn. The
 *    view pins to the end and auto-follows new entries; scrolling up unpins
 *    (a "⋮ N earlier" marker appears), reaching the bottom again (or End)
 *    re-pins.
 *  - brief: the run's inputs and vitals — task and context verbatim (wrapped;
 *    head+tail elided when huge), safe inherited-conversation size/truncation
 *    metadata, the reference file list annotated with ✓/· for whether the
 *    child's tool calls touched each file, usage and time
 *    stats, the fallback trace, and a stderr tail on failures.
 *
 * Steer input is modal so keys never conflict with the editor: browse mode
 * owns navigation; `s` opens the editor (Enter sends and returns to browse,
 *    Esc cancels and clears). Esc in browse closes the overlay; Tab cycles
 *    the focused run and resets its view — page back to activity, scrolls
 *    re-pinned.
 *
 * Layout: a centered screen overlay (overlay:true) occupying most of the
 * terminal, framed with a thin border. An embedded Editor accepts steering
 * input for the focused run; Enter queues the message through the run's RPC
 * stdin channel — delivered after the child's current tool batch, before its
 * next LLM call.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Editor,
  type Component,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RunHandle } from "./run.ts";
import type { ActivityEntry } from "./types.ts";
import {
  briefFilesUsed,
  formatFallback,
  formatThinking,
  formatTimePart,
  formatToolCall,
  formatTokens,
  formatUsageStats,
  runIcon,
  shortenPath,
  statusStyle,
  taskPreview,
} from "./utils.ts";

/** Max body lines kept visible; older lines scroll off behind a marker. */
const VIEWPORT_LINES = 26;
/** Animation tick for the running-entry ellipsis. */
const ANIMATION_INTERVAL_MS = 150;
/** Brief-page text (task/context) is elided to head+tail beyond this many
 *  chars, so huge contexts stay cheap to re-wrap on every animation tick. */
const BRIEF_TEXT_CAP = 20_000;

type TuiLike = { requestRender(): void };
type Fg = (color: string, text: string) => string;
type Page = "activity" | "brief";
type Mode = "browse" | "steer";

/** Pad a string with trailing spaces to a visible width (left-justified). */
function padRight(s: string, width: number): string {
  const v = visibleWidth(s);
  return v >= width ? s : s + " ".repeat(width - v);
}

/** Animated ellipsis suffix for running entries: ".", "..", "..." cycling. */
function dots(): string {
  return ".".repeat(1 + (Math.floor(Date.now() / 300) % 3));
}

/** Normalize one keypress to its printable character (Kitty CSI-u aware). */
function printableChar(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  return data.length === 1 && data >= " " && data <= "~" ? data : undefined;
}

/** Center a string within `width` visible columns (pad-right handles the tail). */
function centerText(s: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - visibleWidth(s)) / 2));
  return " ".repeat(pad) + s;
}

/** Elide oversized brief text to head + tail around an elision marker. */
function capBriefText(text: string): string {
  if (text.length <= BRIEF_TEXT_CAP) return text;
  const head = text.slice(0, Math.floor(BRIEF_TEXT_CAP * 0.8));
  const tail = text.slice(-Math.floor(BRIEF_TEXT_CAP * 0.2));
  const elided = text.length - head.length - tail.length;
  return `${head}\n… [${formatTokens(elided)} chars elided] …\n${tail}`;
}

/**
 * Build the display list of runs for the panel: running/queued first, then
 * finished, each group ordered by registry id.
 */
export function sortViewRuns(runs: RunHandle[]): RunHandle[] {
  const rank = (r: RunHandle) => (r.state === "running" || r.state === "queued" ? 0 : 1);
  return [...runs].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/**
 * Drop terminal runs whose result is already in the conversation — delivered
 * by subagent_check on the active branch (the same session-tree source of
 * truth as the inbox reminder). Live runs and undelivered terminal runs
 * stay: the view is for live watching and pending collection, not an
 * archive.
 */
export function filterDeliveredRuns(runs: RunHandle[], delivered: Set<string>): RunHandle[] {
  return runs.filter(
    (r) => (r.state !== "finished" && r.state !== "failed") || !delivered.has(r.id),
  );
}

/**
 * @internal — exported for testing; formats the metadata shown in the brief view.
 */
export function inheritedConversationFields(
  chars: number,
  truncated: boolean,
): Array<[label: string, value: string]> {
  return [
    ["inherited", "yes"],
    ["size", `${formatTokens(chars)} chars`],
    ["truncated", truncated ? "yes" : "no"],
  ];
}

export class SubagentViewPanel implements Component, Focusable {
  focused = true;

  private runsProvider: () => RunHandle[];
  private theme: Theme;
  private tui: TuiLike;
  private close: () => void;
  private editor: Editor;
  /** Focused run id (Tab cycles); the whole viewport belongs to it. */
  private focusId: string | null = null;
  /** browse = navigation keys; steer = the editor owns input. */
  private mode: Mode = "browse";
  /** Focused run's visible page. */
  private page: Page = "activity";
  /** Activity scroll: null = pinned to the end (auto-follow), else the
   *  index of the first visible entry line. */
  private activityTop: number | null = null;
  /** Brief scroll: index of the first visible line (clamped in render). */
  private briefTop = 0;
  /** Brief scroll ceiling, recomputed each render (content is static). */
  private briefMax = 0;
  /** Transient feedback line ("steer sent to sub-N"), auto-clears. */
  private flash = "";
  private flashUntil = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    runsProvider: () => RunHandle[],
    tui: TuiLike,
    theme: Theme,
    onClose: () => void,
  ) {
    this.runsProvider = runsProvider;
    this.tui = tui;
    this.theme = theme;
    this.close = onClose;

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    this.editor = new Editor(tui as never, editorTheme);
    this.editor.onSubmit = (value) => this.submitSteer(value);

    // Drive the ellipsis animation while the panel is open.
    this.timer = setInterval(() => {
      try {
        this.tui.requestRender();
      } catch {
        /* ignore */
      }
    }, ANIMATION_INTERVAL_MS);
  }

  /** Resolve the focused run by id; stable across sort-order reshuffles
   *  (e.g. a run finishing re-ranks the list). The focused run's view state
   *  (page + scrolls) resets only when the focused run actually changes. */
  private focusedRun(): RunHandle | undefined {
    const runs = sortViewRuns(this.runsProvider());
    if (runs.length === 0) {
      this.focusId = null;
      return undefined;
    }
    let run = runs.find((r) => r.id === this.focusId);
    if (!run) {
      run = runs[0];
      this.focusId = run.id;
      this.resetRunView();
    }
    return run;
  }

  /** Reset the focused run's view state: page back to activity, activity
   *  pinned to the end (auto-follow), brief at the top. */
  private resetRunView(): void {
    this.page = "activity";
    this.activityTop = null;
    this.briefTop = 0;
  }

  private cycleRun(): void {
    const runs = sortViewRuns(this.runsProvider());
    if (runs.length < 2) return;
    const idx = runs.findIndex((r) => r.id === this.focusId);
    // Focus id gone from the list: fall back to the first run, same as
    // focusedRun() — not to the second.
    const next = idx < 0 ? runs[0] : runs[(idx + 1) % runs.length];
    if (next.id === this.focusId) return;
    this.focusId = next.id;
    this.resetRunView();
    this.tui.requestRender();
  }

  private submitSteer(value: string): void {
    const text = value.trim();
    if (!text) return;
    const target = this.focusedRun();
    if (!target || target.state !== "running") {
      this.showFlash("focused run is not running — nothing to steer");
      return;
    }
    target.steer(text);
    this.editor.setText("");
    this.showFlash(`steer queued for ${target.id} (${target.role})`);
    this.mode = "browse";
  }

  private showFlash(message: string): void {
    this.flash = message;
    this.flashUntil = Date.now() + 3000;
  }

  handleInput(data: string): void {
    if (this.mode === "steer") {
      // Everything types into the editor; Esc cancels (never closes the panel).
      if (matchesKey(data, Key.escape)) {
        this.editor.setText("");
        this.mode = "browse";
        this.tui.requestRender();
        return;
      }
      this.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.closePanel();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.cycleRun();
      return;
    }
    const ch = printableChar(data);
    if (ch === "d") {
      this.page = this.page === "activity" ? "brief" : "activity";
      this.tui.requestRender();
      return;
    }
    if (ch === "s") {
      this.mode = "steer";
      this.tui.requestRender();
      return;
    }
    const page = Math.max(3, this.browseBudget() - 1);
    if (matchesKey(data, Key.up)) this.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-page);
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(page);
    else if (matchesKey(data, Key.home)) {
      if (this.page === "activity") this.activityTop = 0;
      else this.briefTop = 0;
      this.tui.requestRender();
    } else if (matchesKey(data, Key.end)) {
      if (this.page === "activity") this.activityTop = null;
      else this.briefTop = this.briefMax;
      this.tui.requestRender();
    }
  }

  /** Scroll the visible page by `delta` lines. Activity pins back to the end
   *  once the bottom is reached (auto-follow resumes). */
  private scrollBy(delta: number): void {
    if (this.page === "activity") {
      const n = this.focusedRun()?.snapshot.activityLog.length ?? 0;
      const maxTop = Math.max(0, n - this.browseBudget());
      const cur = this.activityTop ?? maxTop;
      const next = Math.max(0, Math.min(maxTop, cur + delta));
      this.activityTop = next >= maxTop ? null : next;
    } else {
      this.briefTop = Math.max(0, Math.min(this.briefMax, this.briefTop + delta));
    }
    this.tui.requestRender();
  }

  private closePanel(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.close();
  }

  /** Content line budget in browse mode (tab row + header + steer hint + key hint). */
  private browseBudget(): number {
    return Math.max(3, VIEWPORT_LINES - 4);
  }

  /** Render one activity entry as a static line; running entries get the
   *  animated ellipsis suffix. */
  private renderEntry(e: ActivityEntry, width: number, fg: Fg): string {
    const indent = "  ";
    if (e.kind === "thinking") {
      if (e.status === "running") {
        return truncateToWidth(indent + fg("accent", `◇ thinking${dots()}`), width);
      }
      return truncateToWidth(indent + formatThinking(e.status, fg), width);
    }
    if (e.kind === "steer") {
      const firstLine = (e.text ?? "").trimEnd().split("\n")[0] || "";
      return truncateToWidth(indent + fg("accent", `↩ steer: ${firstLine}`), width);
    }
    if (e.kind === "text") {
      const buffer = e.text ?? "";
      const lastLine = buffer.trimEnd().split("\n").pop() ?? "";
      const body = lastLine || "…";
      if (e.status === "running") {
        return truncateToWidth(indent + fg("accent", `¶ ${body}${dots()}`), width);
      }
      // Frozen: no ANSI at all — same plain terminal foreground as the main
      // UI's output text (theme "text" is a grey var, not the default fg).
      return truncateToWidth(indent + `¶ ${body}`, width);
    }
    const { prefix, color } = statusStyle(e.status, fg);
    const suffix = e.status === "running" ? fg("accent", ` ${dots()}`) : "";
    const line = prefix + formatToolCall(e.toolName ?? "?", e.args ?? {}, color) + suffix;
    return truncateToWidth(indent + line, width);
  }

  /** Render the brief page's full content (pre-scroll): task/context verbatim,
   *  inherited-conversation metadata, annotated files, stats, fallback trace,
   *  and failure stderr tail. */
  private renderBriefLines(run: RunHandle, width: number, fg: Fg): string[] {
    const snap = run.snapshot;
    const lines: string[] = [];
    const section = (title: string) => {
      const label = `── ${title} `;
      lines.push(fg("dim", label + "─".repeat(Math.max(0, width - visibleWidth(label)))));
    };
    const body = (text: string, color?: string) => {
      for (const ln of wrapTextWithAnsi(capBriefText(text), width - 2)) {
        lines.push(color ? `  ${fg(color, ln)}` : `  ${ln}`);
      }
    };

    section("task");
    body(run.task);

    if (run.context) {
      section(`context · ${formatTokens(run.context.length)} chars`);
      body(run.context);
    }

    if (run.inheritConversation) {
      section("conversation");
      const fields = inheritedConversationFields(
        run.inheritedConversationChars ?? 0,
        run.inheritedConversationTruncated === true,
      );
      const labelWidth = Math.max(...fields.map(([label]) => label.length));
      for (const [label, value] of fields) {
        lines.push(`  ${fg("dim", label.padEnd(labelWidth))}  ${fg("accent", value)}`);
      }
    }

    if (run.files && run.files.length > 0) {
      section(`files · ${run.files.length}`);
      const used = briefFilesUsed(run.files, snap.activityLog);
      for (const f of run.files) {
        lines.push(
          used.get(f)
            ? fg("success", `  ✓ ${shortenPath(f)}`)
            : fg("muted", `  · ${shortenPath(f)}`),
        );
      }
    }

    section("stats");
    const usage = formatUsageStats(snap.usage, snap.model);
    lines.push(fg("dim", `  ${usage || "no usage yet"}`));
    const time = formatTimePart({ ...snap, exitCode: run.state === "queued" ? -1 : snap.exitCode });
    if (time) lines.push(fg("dim", `  ${time}`));
    if (run.state === "finished" || run.state === "failed") {
      lines.push(fg("dim", `  exit ${snap.exitCode}${snap.stopReason ? ` · ${snap.stopReason}` : ""}`));
    }
    if (snap.fallbackFrom) {
      lines.push(fg("warning", `  ⚠ ${formatFallback(snap.fallbackFrom)}`));
    }
    if (run.state === "failed") {
      if (snap.errorMessage) body(snap.errorMessage, "error");
      const tail = stripTerminalSequences(snap.stderr)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-6);
      if (tail.length > 0) {
        lines.push(fg("dim", "  stderr (tail):"));
        for (const l of tail) lines.push(truncateToWidth(fg("muted", `  ${l}`), width));
      }
    }
    return lines;
  }

  /** Push the focused run's current page (activity or brief) as framed rows. */
  private renderPage(run: RunHandle, budget: number, innerW: number, fg: Fg, row: (s: string) => string): string[] {
    const lines: string[] = [];
    if (this.page === "activity") {
      const entries = run.snapshot.activityLog.map((e) => this.renderEntry(e, innerW, fg));
      const maxTop = Math.max(0, entries.length - budget);
      const top = this.activityTop === null ? maxTop : Math.min(this.activityTop, maxTop);
      if (top > 0) lines.push(row(fg("muted", `⋮ ${top} earlier`)));
      for (const ln of entries.slice(top, top + budget - (top > 0 ? 1 : 0))) lines.push(row(ln));
      return lines;
    }
    const all = this.renderBriefLines(run, innerW, fg);
    this.briefMax = Math.max(0, all.length - budget);
    this.briefTop = Math.min(this.briefTop, this.briefMax);
    if (this.briefTop > 0) lines.push(row(fg("muted", `⋮ ${this.briefTop} earlier`)));
    for (const ln of all.slice(this.briefTop, this.briefTop + budget - (this.briefTop > 0 ? 1 : 0))) {
      lines.push(row(ln));
    }
    return lines;
  }

  render(width: number): string[] {
    const th = this.theme;
    // Same adaptation render.ts uses: utils formatters take a loose Fg.
    const fg = th.fg.bind(th) as unknown as Fg;
    // Border frame: inner content lives at width-2.
    const innerW = Math.max(20, width - 2);
    const row = (content: string) => {
      const fitted = truncateToWidth(content, innerW);
      return th.fg("border", "│") + padRight(fitted, innerW) + th.fg("border", "│");
    };

    const runs = sortViewRuns(this.runsProvider());
    const lines: string[] = [];
    const runningCount = runs.filter((r) => r.state === "running").length;
    const focused = this.focusedRun();

    // ── Tab row: one cell per run; the focused one is highlighted. ──
    if (runs.length > 0) {
      // Brackets stay on every cell, focused included — the selectedBg +
      // accent highlight is the indicator, so Tab doesn't shift text.
      const cells = runs.map((r) => {
        const isFocused = r === focused;
        const label = `${runIcon(r.snapshot, fg)} ${r.id} ${r.role}`;
        const styled = isFocused ? th.bg("selectedBg", fg("accent", label)) : fg("dim", label);
        return `[${styled}]`;
      });
      lines.push(
        row(
          `${fg("accent", th.bold("subagents"))} ${th.fg("dim", `${runningCount} running · ${runs.length} total · Tab switch`)}  ` +
            cells.join(th.fg("dim", " ")),
        ),
      );
    } else {
      // Empty registry — every run left the view (a run disappears once its
      // result is in the conversation). Give the state real presence — a
      // full-size panel with a centered message and the close hint — and
      // fold steer mode back to browse so Esc closes immediately.
      if (this.mode === "steer") {
        this.editor.setText("");
        this.mode = "browse";
      }
      lines.push(row(""));
      lines.push(row(fg("muted", centerText("no subagent runs", innerW))));
      lines.push(
        row(
          fg(
            "dim",
            centerText("a run leaves the view once its result is in the conversation", innerW),
          ),
        ),
      );
      lines.push(row(""));
      lines.push(row(""));
      lines.push(row(fg("dim", "Esc close")));
    }

    // ── Focused run: header line, then the current page. ──
    if (focused) {
      const snap = focused.snapshot;
      const icon = runIcon(snap, fg);
      const time = formatTimePart({ ...snap, exitCode: focused.state === "queued" ? -1 : snap.exitCode });
      const inputBits: string[] = [];
      if (focused.files?.length) {
        inputBits.push(`${focused.files.length} file${focused.files.length === 1 ? "" : "s"}`);
      }
      if (focused.context) inputBits.push(`context ${formatTokens(focused.context.length)}`);
      const parts = [
        `${icon} ${fg("accent", th.bold(focused.id))}`,
        fg("text", focused.role),
        fg("dim", taskPreview(focused.task)),
        ...(inputBits.length > 0 ? [fg("dim", inputBits.join(" · "))] : []),
        time ? fg("dim", time) : "",
        fg("dim", formatUsageStats(snap.usage, snap.model)),
      ].filter(Boolean);
      lines.push(row(parts.join(th.fg("dim", " · "))));

      if (this.mode === "steer") {
        const edLines = this.editor.render(innerW);
        const budget = Math.max(3, VIEWPORT_LINES - 3 - edLines.length);
        lines.push(...this.renderPage(focused, budget, innerW, fg, row));
        const label =
          focused.state === "running"
            ? fg("accent", `${focused.id} (${focused.role})`)
            : fg("dim", focused.state === "queued" ? `${focused.id} still queued` : `${focused.id} not running`);
        lines.push(row(fg("dim", `steer → ${label}`)));
        for (const el of edLines) lines.push(row(el));
        lines.push(row(fg("dim", "Enter send · Esc cancel")));
      } else {
        lines.push(...this.renderPage(focused, this.browseBudget(), innerW, fg, row));
        if (Date.now() < this.flashUntil) {
          lines.push(row(fg("success", this.flash)));
        } else {
          const label =
            focused.state === "running"
              ? fg("accent", `${focused.id} (${focused.role})`)
              : fg("dim", focused.state === "queued" ? `${focused.id} still queued` : `${focused.id} not running`);
          lines.push(row(fg("dim", `steer → ${label} · press s`)));
        }
        const pageKey = this.page === "activity" ? "d brief" : "d activity";
        lines.push(row(fg("dim", `↑↓ scroll · ${pageKey} · Tab run · s steer · Esc close`)));
      }
    }

    // Frame.
    return [
      th.fg("border", `╭${"─".repeat(innerW)}╮`),
      ...lines,
      th.fg("border", `╰${"─".repeat(innerW)}╯`),
    ];
  }

  invalidate(): void {}
}

/** Wire the panel to the overlay lifecycle: the animation timer dies with the panel. */
export function createViewPanel(
  runsProvider: () => RunHandle[],
  tui: TuiLike,
  theme: Theme,
  onClose: () => void,
): SubagentViewPanel {
  return new SubagentViewPanel(runsProvider, tui, theme, onClose);
}
