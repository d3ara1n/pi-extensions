/**
 * pi-ask-user — An ask-user tool for pi.
 *
 * Design notes:
 *   - Collapsible panel (Ctrl+\) shrinks the panel to one row so more of the
 *     transcript stays on screen. Chat scrolling does NOT depend on keyboard
 *     focus at all — it is the terminal scrollback (see Layout note below), so
 *     it works whether the panel is expanded, collapsed, or focused.
 *   - Per-question state (cursor position, scroll offset, type-something draft,
 *     multi-select picks) survives tab navigation — switching tabs never loses
 *     what you typed.
 *   - Single-select icons (◎→◉) and multi-select icons (□→▣) all live in the
 *     U+25A0–25FF Geometric Shapes block, so any font that renders one renders
 *     all. The cursor indicator (▸) is independent of the "selected" glyph:
 *     moving up/down only moves ▸; Enter fills the selected glyph.
 *   - Rich option previews: if any option of a question carries a `preview`
 *     field, the question renders in two equal columns (options | preview);
 *     otherwise it renders single-column full-width.
 *
 * Layout: renders into pi's bottom `editorContainer` slot (overlay:false, NOT a
 *   screen overlay). The chat transcript stays visible ABOVE the panel and is
 *   scrollable via the terminal's native scrollback (mouse wheel / Shift-PgUp /
 *   Cmd-↑). This works because pi's TUI never enters alt-screen and never tracks
 *   the mouse, so every rendered chat line lives in the terminal buffer and can
 *   be scrolled back at any time — the exact mechanism ctx.ui.select()/input()
 *   rely on. (overlay:true would route through ui.showOverlay(), compositing the
 *   panel over the whole screen and visually hiding the transcript — making it
 *   unscrollable, which was the original bug.) Collapses to one status row.
 */

import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ────────────────────────────────────────────────────────────────────────────
// Icon constants — all in U+25A0–25FF Geometric Shapes for font consistency
// ────────────────────────────────────────────────────────────────────────────

const ICON_RADIO_EMPTY = "○"; // U+25CB white circle
const ICON_RADIO_FILLED = "◉"; // U+25C9 fisheye
const ICON_CHECK_EMPTY = "□"; // U+25A1
const ICON_CHECK_FILLED = "▣"; // U+25A3
const ICON_OTHER = "✎"; // pencil for "Type something."
const ICON_CURSOR = "▸"; // current cursor position, independent of selection
const ICON_NOTE = ICON_OTHER; // same ✎ pencil as custom answers — the note is also free-form user input
const ICON_ANSWER = "›"; // lead glyph on option-pick answers in the result card

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface QuestionOption {
  label: string;
  description?: string;
  /** Rich preview shown in the right column when this option is focused. */
  preview?: string;
}

interface RenderOption extends QuestionOption {
  isOther?: boolean;
}

interface Question {
  tab: string;
  header: string;
  prompt?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowSkip?: boolean;
}

/** A committed answer. Discriminated by `kind` so every state carries exactly
 *  the fields it needs — the compiler guarantees completeness, and the three
 *  display/serialization consumers all derive from `describeAnswer()` (single
 *  source of truth) so they can never drift apart.
 *
 *  - `single`: the user picked one of the offered options.
 *  - `custom`: single-select, the user typed a custom answer ("Type something.").
 *  - `multi`:  multi-select — `options` are the picked option labels; an
 *    optional `custom` carries any typed text alongside them. Pure-custom
 *    (no options checked) is `options: []` + `custom`; an empty commit
 *    (skippable, submitted with nothing) is `options: []` with no `custom`.
 *  - `skipped`: the user navigated past without answering (Tab/arrows).
 */
type Answer =
  | { tab: string; kind: "single"; option: string }
  | { tab: string; kind: "custom"; text: string }
  | { tab: string; kind: "multi"; options: string[]; custom?: string }
  | { tab: string; kind: "skipped" };

interface AskUserResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
  /** Free-form note the user can attach on the review screen. Absent when empty. */
  message?: string;
}

/** Per-tab ephemeral UI state. Preserved across tab switches. */
interface TabState {
  /** Cursor position (where ▸ is). */
  cursor: number;
  /** Vertical scroll offset for the options viewport. */
  scrollOffset: number;
  /** Whether "Type something." input mode is active for this tab. */
  inputMode: boolean;
  /** This tab's own editor instance (its draft lives inside; no cross-tab sync needed). */
  editor: Editor;
  /** Indices of committed options (multi-select). */
  multiChecked: Set<number>;
  /** Committed custom text for multi-select mode (kept alongside multiChecked, never overwriting it). Null if none. */
  customText: string | null;
  /** Committed single-select index (or -1 if none yet, -2 = answered via type-something). */
  selectedSingle: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────────────────

const QuestionOptionSchema = Type.Object({
  label: Type.String({
    description: "Short display label for the option (shown on the selection row)",
  }),
  description: Type.Optional(
    Type.String({
      description:
        "Short explanation shown under the label (wraps). Add one when the label alone isn't self-explanatory.",
    }),
  ),
  preview: Type.Optional(
    Type.String({
      description:
        "Use this when `description` (a short one-liner) is not enough and the user genuinely benefits from seeing more detail in a side column — e.g. an ASCII layout demo, a code skeleton, a Pro/Cons breakdown, or the reasoning behind why this option is offered and what choosing it entails. Rendered verbatim in a side column (spaces/newlines preserved). Do NOT treat preview as extra text capacity. Every line competes for the user's attention against the option list; only add a preview when the content is worth reading, not just because there's room for more words. If a short `description` already conveys the option, leave preview empty. Most options need only `description`.",
    }),
  ),
});

const QuestionSchema = Type.Object({
  header: Type.String({
    description: "Short question title shown in the panel header, e.g. 'Which layout?'",
  }),
  tab: Type.String({
    description:
      'Short keyword that identifies this question. Shown on the tab bar when there are multiple questions, and returned in the result as the answer\'s prefix. Write it in the user\'s language (e.g. "数据库" or "布局" in a Chinese conversation, "Database" or "Layout" in English), not as a programmatic identifier like "db_choice". Must be unique across questions in one call.',
  }),
  prompt: Type.Optional(
    Type.String({ description: "Optional longer body text shown under the header" }),
  ),
  options: Type.Array(QuestionOptionSchema, {
    description:
      "Available options. Pass 2-4; each needs a short `label` + a `description`, and a `preview` only when a description can't fully convey the option.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "If true, the user may check multiple options (space toggles, enter commits). Default false.",
    }),
  ),
  allowSkip: Type.Optional(
    Type.Boolean({
      description:
        "If false, the user MUST answer before proceeding (Tab/Enter with no selection is blocked). Default true. Use false for required questions.",
    }),
  ),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "One or more questions to ask" }),
});

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Collapse/expand toggle. Ctrl+\ (0x1c) is free in pi's built-in keybindings
 * (unlike Ctrl+] which collides with tui.editor.jumpForward) and is not used
 * as a prefix by tmux/zellij/screen/ssh.
 */
const TOGGLE_KEY = Key.ctrl("\\");
const TOGGLE_HINT = "Ctrl+\\";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function wrapTab(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index % total) + total) % total;
}

/** Build the full option list for a question, always appending the "Type something." custom-input row. */
function buildOptions(q: Question): RenderOption[] {
  const opts: RenderOption[] = [...q.options];
  opts.push({ label: "Type something.", isOther: true });
  return opts;
}

function isMulti(q: Question | undefined): boolean {
  return !!q?.multiSelect;
}

/** Whether the user is allowed to skip this question (default true). */
function canSkip(q: Question | undefined): boolean {
  return q?.allowSkip !== false;
}

/** Does this question use the two-column (options | preview) layout? */
function isDualColumn(q: Question | undefined): boolean {
  if (!q) return false;
  return q.options.some((o) => o.preview);
}

function newTabState(
  tui: TuiLike,
  theme: EditorTheme,
  tabIndex: number,
  onSubmit: (tabIndex: number, value: string) => void,
): TabState {
  const editor = new Editor(tui as never, theme);
  editor.onSubmit = (value) => onSubmit(tabIndex, value);
  return {
    cursor: 0,
    scrollOffset: 0,
    inputMode: false,
    editor,
    multiChecked: new Set(),
    customText: null,
    selectedSingle: -1,
  };
}

function errorResult(
  message: string,
  questions: Question[] = [],
): {
  content: { type: "text"; text: string }[];
  details: AskUserResult;
} {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

/** Pad a string with trailing spaces to a visible width (left-justified). */
function padRight(s: string, width: number): string {
  const v = visibleWidth(s);
  return v >= width ? s : s + " ".repeat(width - v);
}

/** Truncate to a visible width, appending “…” only when the text actually
 *  overflows. (truncateToWidth's third arg is a fill, not a suffix, so we
 *  reserve one column and append the ellipsis ourselves when needed.) */
function truncForDisplay(text: string, maxW: number): string {
  if (maxW <= 0) return "";
  if (maxW === 1) return "…";
  const vw = visibleWidth(text);
  if (vw <= maxW) return text;
  return truncateToWidth(text, maxW - 1, "") + "…";
}

/** Structured interpretation of an Answer for display/serialization.
 *  Single source of truth — all three consumers (review screen's
 *  formatAnswerText, result card's formatAnswer, execute's JSON payload)
 *  derive from this, so they can never drift apart. */
interface AnswerView {
  /** Human-readable text WITHOUT ANSI — e.g. "Sidebar" / "甲, 乙" /
   *  "✎ 自定义文本" / "(none)" / "(skipped)". Consumers wrap it in color. */
  text: string;
  /** Theme color name for the whole text. */
  color: ThemeColor;
}

/** Interpret an Answer into display form. `customGlyph` (default "✎") prefixes
 *  any custom text. Returns `(no answer)` / dim for an absent answer. */
function describeAnswer(ans: Answer | undefined, customGlyph = ICON_OTHER): AnswerView {
  if (!ans) return { text: "(no answer)", color: "dim" };
  switch (ans.kind) {
    case "skipped":
      return { text: "(skipped)", color: "warning" };
    case "multi": {
      if (ans.options.length === 0 && !ans.custom) return { text: "(none)", color: "dim" };
      const parts = [...ans.options];
      if (ans.custom) parts.push(`${customGlyph} ${ans.custom}`);
      return { text: parts.join(", "), color: "text" };
    }
    case "custom":
      return { text: `${customGlyph} ${ans.text}`, color: "text" };
    case "single":
      return { text: ans.option, color: "text" };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// The overlay component
// ────────────────────────────────────────────────────────────────────────────

interface TuiLike {
  requestRender(): void;
}

interface PanelCallbacks {
  onResult: (result: AskUserResult) => void;
}

class AskUserPanel implements Component, Focusable {
  focused = false;

  private questions: Question[];
  private theme: Theme;
  private tui: TuiLike;
  private cb: PanelCallbacks;

  // ── state ──
  private currentTab = 0;
  private answers = new Map<string, Answer>();
  private collapsed = false;
  private tabs: TabState[];
  /** Visible option rows (recomputed each render). */
  private optionViewportH = 8;
  /** Cursor row in the review summary (shown on the review tab). */
  private reviewCursor = 0;
  /** Vertical scroll offset for the review viewport. */
  private reviewScrollOffset = 0;
  /** Visible review rows (recomputed each render). */
  private reviewViewportH = 8;
  /** True while the user is editing the free-form "note to assistant" on the
   *  review tab. While true, all input goes to messageEditor. */
  private messageEditing = false;
  /** Committed note text (trimmed). Empty string = no note. Lives only on the
   *  review screen; the LLM cannot set it. */
  private messageText = "";
  /** Dedicated editor for the note. Single-line semantics: Enter saves (like
   *  the per-question "Type something." editor). */
  private messageEditor: Editor;

  // ── render cache ──
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(questions: Question[], tui: TuiLike, theme: Theme, cb: PanelCallbacks) {
    this.questions = questions;
    this.tui = tui;
    this.theme = theme;
    this.cb = cb;

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
    // Each tab owns its own Editor instance — its internal state IS that tab's
    // draft, so tab switching needs no text shuttling. This is the fix for the
    // draft-loss bug (previously a single shared editor was swapped in/out and
    // the swap was lossy across the input-mode / tab-switch boundary).
    this.tabs = questions.map((_, i) =>
      newTabState(tui, editorTheme, i, (ti, v) => this.handleSubmit(ti, v)),
    );
    // Dedicated editor for the review-screen note. Enter saves (single-line),
    // Esc returns to the review without saving — mirroring the per-question
    // "Type something." editor's semantics.
    this.messageEditor = new Editor(tui as never, editorTheme);
    this.messageEditor.onSubmit = (value) => this.handleMessageSubmit(value);
  }

  /** Shared submit logic bound to each tab's editor. */
  private handleSubmit(tabIndex: number, value: string): void {
    const q = this.questions[tabIndex];
    const st = this.tabs[tabIndex];
    if (!q || !st) return;
    const trimmed = value.trim();
    if (!trimmed) {
      // empty → back to options. In multi-select mode, an empty submit also
      // clears any previously committed custom text (blank = "remove my custom
      // answer"), then re-commits the remaining checked options.
      st.inputMode = false;
      st.editor.setText("");
      if (isMulti(q)) {
        st.customText = null;
        if (!this.commitMultiAnswer(q, st)) this.answers.delete(q.tab);
      }
      if (tabIndex === this.currentTab) this.invalidate();
      return;
    }
    if (isMulti(q)) {
      // Multi-select: the custom text is an extra entry kept ALONGSIDE the
      // checked options — it must NOT overwrite them. (Previously this path
      // did answers.set with only the custom text, dropping every check.)
      // Committing custom text only records it — we return to the OPTION LIST
      // (not advance) so the user can keep checking options and then press
      // Enter on an option to confirm the whole question. Advancing here used
      // to jump straight to review the moment the custom editor closed.
      st.customText = trimmed;
      this.commitMultiAnswer(q, st);
      st.inputMode = false;
      if (tabIndex === this.currentTab) this.invalidate();
      return;
    }
    this.answers.set(q.tab, {
      tab: q.tab,
      kind: "custom",
      text: trimmed,
    });
    st.selectedSingle = -1; // clear any prior option pick — answer is now custom
    st.inputMode = false;
    if (tabIndex === this.currentTab) {
      this.advanceAfterAnswer();
    }
  }

  /** Save the review-tab note: trim, store, return to the review tab.
   *  currentTab already points at the review tab (note editing is only
   *  entered from there), so we just clear the editing flag. Empty = no note. */
  private handleMessageSubmit(value: string): void {
    this.messageText = value.trim();
    this.messageEditing = false;
    this.invalidate();
  }

  /**
   * Multi-select commit: merge the checked options (st.multiChecked) together
   * with the committed custom text (st.customText) into one multi-select
   * answer. Returns false when there is nothing to commit (no checks and no
   * custom text), so the caller can delete the stale answer if desired.
   */
  private commitMultiAnswer(q: Question, st: TabState): boolean {
    const opts = buildOptions(q);
    const picked = Array.from(st.multiChecked)
      .sort((a, b) => a - b)
      .map((i) => opts[i])
      .filter((o): o is RenderOption => !!o && !o.isOther);
    const labels = picked.map((o) => o.label);
    const customText = st.customText;
    // Empty commit = no option picks AND no custom text. (A skippable
    // multi-select still records an explicit empty answer via the Enter
    // path — see handleInput — so this function returning false just means
    // "nothing to record here".)
    if (labels.length === 0 && !customText) return false;
    const ans: Answer = {
      tab: q.tab,
      kind: "multi",
      options: labels,
    };
    if (customText) ans.custom = customText;
    this.answers.set(q.tab, ans);
    return true;
  }

  // ── accessors ──

  /** Total number of tabs: one per question, plus the trailing review tab. */
  private get totalTabs(): number {
    return this.questions.length + 1;
  }

  /** The review tab sits at index === questions.length (the last tab).
   *  While true, the panel renders the review summary instead of a question. */
  private get isReviewTab(): boolean {
    return this.currentTab === this.questions.length;
  }

  private currentQuestion(): Question | undefined {
    return this.questions[this.currentTab];
  }

  private currentTabState(): TabState {
    return this.tabs[this.currentTab]!;
  }

  private currentOptions(): RenderOption[] {
    const q = this.currentQuestion();
    return q ? buildOptions(q) : [];
  }

  private advanceAfterAnswer(): void {
    // Advance to the next tab. The review tab is the last tab, so answering
    // the final question lands the user on the review tab (where Enter
    // submits). Navigation is now uniform: review is just the next tab,
    // reached by the same Tab/→ keys as any question — no special "enter
    // review" step. Safe because this is only called from question tabs
    // (currentTab < questions.length), so currentTab + 1 <= reviewTabIndex.
    this.switchTab(this.currentTab + 1);
  }

  /**
   * Called before navigating AWAY from a question tab (Tab/→/←/Shift+Tab).
   * Resolves the current question's state so it can be left cleanly:
   *
   *  - Already committed (answers.has): leave freely.
   *  - Multi-select with UNCOMMITTED checks (or a typed custom text): a check
   *    IS an answer — commit it first, then leave. Navigating away with
   *    pending checks must submit them (not skip, not block), regardless of
   *    allowSkip, because the user has already expressed a choice. (Single-
   *    select commits on Space, so it never has pending uncommitted state.)
   *  - Nothing selected at all:
   *      allowSkip true  → record a skipped answer, allow leaving.
   *      allowSkip false → block (a required question must be answered).
   *
   * Returns true when navigation may proceed.
   */
  private prepareQuestionForLeave(): boolean {
    const q = this.currentQuestion();
    if (!q) return true;
    if (this.answers.has(q.tab)) return true;
    const st = this.currentTabState();
    // Multi-select: uncommitted checks count as an answer — commit them,
    // then leave. commitMultiAnswer only returns false when there's nothing
    // to commit (no checks, no custom), which the guard already rules out.
    if (isMulti(q) && (st.multiChecked.size > 0 || !!st.customText)) {
      this.commitMultiAnswer(q, st);
      return true;
    }
    if (!canSkip(q)) return false; // required question, nothing chosen: block
    this.answers.set(q.tab, {
      tab: q.tab,
      kind: "skipped",
    });
    return true;
  }

  private submit(cancelled: boolean): void {
    this.cb.onResult({
      questions: this.questions,
      answers: Array.from(this.answers.values()),
      cancelled,
      // Only attach the note when non-empty. A cancelled submit still carries
      // the note if the user wrote one (it may explain why they cancelled).
      message: this.messageText || undefined,
    });
  }

  private setCollapsed(next: boolean): void {
    if (this.collapsed === next) return;
    this.collapsed = next;
    this.invalidate();
  }

  private clampScrollToCursor(): void {
    const opts = this.currentOptions();
    if (opts.length === 0) return;
    const viewH = this.optionViewportH;
    const st = this.currentTabState();
    if (st.cursor < st.scrollOffset) st.scrollOffset = st.cursor;
    else if (st.cursor >= st.scrollOffset + viewH) st.scrollOffset = st.cursor - viewH + 1;
    if (st.scrollOffset < 0) st.scrollOffset = 0;
  }

  // ── input ──

  handleInput(data: string): void {
    // 1. Note editor (messageEditing): owns all input while active. Esc
    //    returns to the review tab (currentTab already points there — note
    //    editing is only entered from the review tab).
    if (this.messageEditing) {
      if (matchesKey(data, Key.escape)) {
        this.messageEditing = false;
        this.invalidate();
        return;
      }
      this.messageEditor.handleInput(data);
      this.invalidate();
      return;
    }

    // 2. Collapse toggle (global, any tab).
    if (matchesKey(data, TOGGLE_KEY)) {
      this.setCollapsed(!this.collapsed);
      return;
    }

    // 3. Collapsed: only Esc (cancel) is meaningful.
    if (this.collapsed) {
      if (matchesKey(data, Key.escape)) this.submit(true);
      return;
    }

    // 4. Question tab + "Type something." input mode: the editor owns ALL
    //    editing keys (Tab, arrows, etc.). Tab is NOT hijacked for tab
    //    switching here, because that would break indentation / cursor
    //    movement. Esc exits back to the option list. The review tab has no
    //    input mode (it never edits options), so it skips this branch — the
    //    `!this.isReviewTab` short-circuit also avoids indexing tabs[] OOB.
    if (!this.isReviewTab && this.currentTabState().inputMode) {
      if (matchesKey(data, Key.escape)) {
        const st = this.currentTabState();
        st.inputMode = false;
        // Keep the editor content (per-tab editor preserves it as draft).
        this.invalidate();
        return;
      }
      this.currentTabState().editor.handleInput(data);
      this.invalidate();
      return;
    }

    // 5. Esc = cancel submission (any tab, when not editing).
    if (matchesKey(data, Key.escape)) {
      this.submit(true);
      return;
    }

    // 6. Shared tab navigation — Tab/→ forward, Shift+Tab/← backward.
    //    Runs on BOTH question tabs and the review tab, which is what makes
    //    the review reachable by the same keys as any question. The skip
    //    check only applies when LEAVING a question tab (never the review).
    if (this.handleTabNavigation(data)) return;

    // 7. Review tab: ↑↓ move · Space edit · Enter submit. (Esc + tab
    //    navigation were already handled above.)
    if (this.isReviewTab) {
      return this.handleReviewInput(data);
    }

    // 8. Question tab: ↑↓ move cursor · Space toggle/commit · Enter confirm.
    const st = this.currentTabState();
    const q = this.currentQuestion();
    if (!q) return;
    const opts = this.currentOptions();
    const multi = isMulti(q);

    // Up / Down — moves ONLY the cursor (▸), does not change selection
    if (matchesKey(data, Key.up)) {
      if (st.cursor > 0) {
        st.cursor--;
        this.clampScrollToCursor();
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (st.cursor < opts.length - 1) {
        st.cursor++;
        this.clampScrollToCursor();
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      st.cursor = Math.max(0, st.cursor - Math.max(1, this.optionViewportH));
      this.clampScrollToCursor();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      st.cursor = Math.min(opts.length - 1, st.cursor + Math.max(1, this.optionViewportH));
      this.clampScrollToCursor();
      this.invalidate();
      return;
    }

    // Space — the "interact" key: select (single), toggle (multi), or EDIT
    // (the "Type something." row). It never advances — that's Enter's job.
    // This mirrors the review tab (where Space opens an entry for editing),
    // so "the key that modifies things" is the same on every screen.
    if (matchesKey(data, Key.space)) {
      const opt = opts[st.cursor];
      if (!opt) return;
      if (opt.isOther) {
        // Enter edit mode for a custom answer. Prefill with any committed
        // custom text so the user edits rather than retypes. Per-tab
        // editor keeps the text for Esc-discard semantics automatically.
        //   - Single-select: custom text lives in the `custom` answer.
        //   - Multi-select:  it lives in st.customText (kept alongside checks).
        st.inputMode = true;
        const existing = this.answers.get(q.tab);
        const prefill = multi ? st.customText : existing?.kind === "custom" ? existing.text : null;
        if (prefill) st.editor.setText(prefill);
        this.invalidate();
        return;
      }
      if (multi) {
        if (st.multiChecked.has(st.cursor)) st.multiChecked.delete(st.cursor);
        else st.multiChecked.add(st.cursor);
        this.invalidate();
        return;
      }
      // single-select: mark the selection WITHOUT advancing (stay on question)
      st.selectedSingle = st.cursor;
      this.answers.set(q.tab, {
        tab: q.tab,
        kind: "single",
        option: opt.label,
      });
      this.invalidate();
      return;
    }

    // Enter — confirm + advance to the next tab. It does NOT enter edit mode
    // (Space owns that now), keeping the two keys orthogonal: Space modifies,
    // Enter commits. Single-select commits the cursor position and advances;
    // multi-select commits the currently checked options as-is and advances
    // (Space owns checking, so Enter no longer auto-checks the cursor option).
    if (matchesKey(data, Key.enter)) {
      const opt = opts[st.cursor];
      if (!opt) return;
      if (opt.isOther && !multi) {
        // Single-select isOther: Enter never edits (Space owns that). Only
        // advance if a custom answer was already committed; otherwise stay.
        if (this.answers.get(q.tab)?.kind === "custom") {
          this.advanceAfterAnswer();
        }
        return;
      }
      if (multi) {
        // Commit the current checks (+ any custom text) and advance. For a
        // skippable multi-select, committing an EMPTY selection is still a
        // commit — Enter means "submit (even if empty) and move on", not
        // "skip" (Tab/arrows do skipping). So we record an explicit empty
        // answer and advance; a required question (!canSkip) with an empty
        // selection stays put, since it must have at least one pick.
        if (this.commitMultiAnswer(q, st)) {
          this.advanceAfterAnswer();
        } else if (canSkip(q)) {
          this.answers.set(q.tab, {
            tab: q.tab,
            kind: "multi",
            options: [],
          });
          this.advanceAfterAnswer();
        }
        return;
      }
      // single-select: commit cursor position as the selection, then advance
      st.selectedSingle = st.cursor;
      this.answers.set(q.tab, {
        tab: q.tab,
        kind: "single",
        option: opt.label,
      });
      this.advanceAfterAnswer();
      return;
    }
  }

  /** Switch tab. Each tab owns its own Editor instance, so draft preservation
   * is automatic — no text shuttling required. */
  private switchTab(next: number): void {
    if (next === this.currentTab) return;
    this.currentTab = next;
    this.invalidate();
  }

  /** Shared tab navigation, invoked from handleInput for BOTH question tabs
   *  and the review tab. Returns true when the key was consumed.
   *
   *  - Tab / →   : forward. Tab WRAPS through every tab (questions → review →
   *                first question); → STOPS at the review tab (boundary).
   *  - Shift+Tab / ← : backward. Shift+Tab wraps; ← stops at the first
   *                question.
   *
   *  Leaving a question tab may need to commit pending multi-select checks
   *  or record a skip (when it's unanswered and required) — that's handled
   *  by prepareQuestionForLeave. Leaving the review tab never needs that
   *  check (it isn't a question), so →/Tab work freely from review. */
  private handleTabNavigation(data: string): boolean {
    if (this.totalTabs <= 1) return false;
    // Forward
    if (matchesKey(data, Key.tab)) {
      if (!this.isReviewTab && !this.prepareQuestionForLeave()) return true; // required: blocked
      this.switchTab(wrapTab(this.currentTab + 1, this.totalTabs));
      return true;
    }
    if (matchesKey(data, Key.right)) {
      if (!this.isReviewTab && !this.prepareQuestionForLeave()) return true; // required: blocked
      if (this.currentTab + 1 >= this.totalTabs) return true; // stop at review
      this.switchTab(this.currentTab + 1);
      return true;
    }
    // Backward
    if (matchesKey(data, Key.shift("tab"))) {
      this.switchTab(wrapTab(this.currentTab - 1, this.totalTabs));
      return true;
    }
    if (matchesKey(data, Key.left)) {
      if (this.currentTab - 1 < 0) return true; // stop at first question
      this.switchTab(this.currentTab - 1);
      return true;
    }
    return false;
  }

  /** Handle input specific to the review tab. Esc and tab navigation
   *  (Tab/←/→) are already handled upstream in handleInput, so here we only
   *  deal with: ↑↓/PgUp/PgDn (move the review cursor), Space (open the entry
   *  under the cursor for editing), and Enter (submit the whole review).
   *
   *  The review list has N question entries plus one trailing "note to
   *  assistant" entry (index N), so the cursor ranges over [0, N]. */
  private handleReviewInput(data: string): void {
    const n = this.questions.length;
    const total = n + 1; // include the note entry
    // ↑/↓/PgUp/PgDn — move the review cursor over [0, total-1]
    if (matchesKey(data, Key.up)) {
      if (this.reviewCursor > 0) {
        this.reviewCursor--;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.reviewCursor < total - 1) {
        this.reviewCursor++;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.reviewCursor = Math.max(0, this.reviewCursor - Math.max(1, this.reviewViewportH));
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.reviewCursor = Math.min(
        total - 1,
        this.reviewCursor + Math.max(1, this.reviewViewportH),
      );
      this.invalidate();
      return;
    }
    // Space — "select" the entry under the cursor: jump into editing it.
    // (Mirrors the option screens, where Space = select/toggle.)
    if (matchesKey(data, Key.space)) {
      if (this.reviewCursor === n) {
        // Note entry: open the note editor. Prefill with the committed note
        // (if any) so the user can tweak rather than retype.
        this.messageEditing = true;
        if (this.messageText) this.messageEditor.setText(this.messageText);
        this.invalidate();
        return;
      }
      // Question entry: switch to that question's tab for editing.
      // switchTab early-returns when next === currentTab, which is fine — that
      // only happens on a single-question call where we're already on the
      // question; nothing to redraw.
      this.switchTab(this.reviewCursor);
      return;
    }
    // Enter — submit the whole review, no matter where the cursor sits.
    if (matchesKey(data, Key.enter)) {
      this.submit(false);
      return;
    }
  }

  // ── render ──

  render(width: number): string[] {
    if (this.collapsed) {
      this.cachedWidth = width;
      this.cachedLines = this.renderCollapsed(width);
      return this.cachedLines;
    }
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    this.cachedWidth = width;
    this.cachedLines = this.renderExpanded(width);
    return this.cachedLines;
  }

  private renderCollapsed(width: number): string[] {
    const th = this.theme;
    const qParts = this.questions.map((q, i) => {
      const done = this.answers.has(q.tab);
      const active = i === this.currentTab && !this.isReviewTab;
      const mark = active ? "▸" : done ? "✓" : "○";
      const color = active ? "accent" : done ? "success" : "dim";
      return th.fg(color, `${q.tab}${mark}`);
    });
    const reviewPart = this.isReviewTab ? th.fg("accent", "Review▸") : th.fg("dim", "Review○");
    const tabsPart = [...qParts, reviewPart].join(th.fg("dim", " "));
    const inner = `${tabsPart}  ${th.fg("dim", ` ${TOGGLE_HINT} expand `)}${th.fg("dim", " Esc cancel ")}`;
    const line =
      th.fg("border", "│") +
      inner +
      " ".repeat(Math.max(0, width - 2 - visibleWidth(inner))) +
      th.fg("border", "│");
    return [truncateToWidth(line, width)];
  }

  /** Build the tab-bar content line (without border wrapping). Shared by the
   *  question screen and the review screen so the bar is always visible —
   *  the review tab is a real tab, so it must highlight when active just like
   *  any question. Callers wrap the returned string in their own row() so the
   *  border color matches the surrounding screen. */
  private renderTabBarContent(th: Theme): string {
    const tabCells = this.questions.map((q, i) => {
      const active = i === this.currentTab;
      const ans = this.answers.get(q.tab);
      let mark = " ";
      let baseColor: import("@earendil-works/pi-coding-agent").ThemeColor = active
        ? "accent"
        : "muted";
      if (ans?.kind === "skipped") {
        mark = "—";
        baseColor = "warning";
      } else if (ans) {
        mark = "✓";
        baseColor = "success";
      } else if (active) mark = "▸";
      const color = active ? "accent" : baseColor;
      return th.fg(color, `${mark} ${q.tab}`);
    });
    const reviewActive = this.isReviewTab;
    const reviewMark = reviewActive ? "▸" : " ";
    const reviewColor: import("@earendil-works/pi-coding-agent").ThemeColor = reviewActive
      ? "accent"
      : "muted";
    const reviewCell = th.fg(reviewColor, `${reviewMark} [ Review ]`);
    const sep = th.fg("dim", "  │");
    return ` ${tabCells.join(th.fg("dim", "  "))}${sep}${reviewCell}`;
  }

  private renderExpanded(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(20, width - 2);
    const lines: string[] = [];
    const row = (content: string) =>
      th.fg("border", "│") + padRight(content, innerW) + th.fg("border", "│");

    if (this.messageEditing) {
      return this.renderMessageEditor(width, innerW, th);
    }
    if (this.isReviewTab) {
      return this.renderReview(width, innerW, th);
    }

    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

    // ── Tab bar ──
    // Always shown: there is always at least one question tab plus the
    // trailing review tab. renderTabBarContent is shared with the review
    // screen so the active tab stays visible across every screen.
    lines.push(row(this.renderTabBarContent(th)));
    lines.push(row(""));

    // ── Question header ──
    const q = this.currentQuestion();
    const multi = isMulti(q);
    const dual = isDualColumn(q);
    const progress =
      this.questions.length > 1 ? `  [${this.currentTab + 1}/${this.questions.length}]` : "";
    const tag = multi ? th.fg("dim", " (multi)") : "";
    const headerText = truncateToWidth(
      ` ${th.fg("accent", th.bold(q?.header ?? ""))}${tag}${th.fg("dim", progress)}`,
      innerW,
      "",
    );
    lines.push(th.fg("border", "│") + padRight(headerText, innerW) + th.fg("border", "│"));

    // ── Prompt body ──
    if (q?.prompt) {
      for (const w of wrapTextWithAnsi(th.fg("muted", q.prompt), innerW - 2))
        lines.push(row(` ${w}`));
    }
    // 空行分隔 header/prompt 与 options。原来只在有 prompt 时才加，导致无
    // prompt 的问题其标题与选项紧贴（"粘在一起"）。现在无条件加。
    lines.push(row(""));

    // ── Body: options / preview / input editor ──
    const st = this.currentTabState();
    if (st.inputMode) {
      for (const el of st.editor.render(innerW - 2)) lines.push(row(` ${el}`));
      lines.push(row(th.fg("dim", " Esc back to options · Enter submit")));
    } else if (dual && q) {
      lines.push(...this.renderDualColumn(q, st, innerW, row, th));
    } else {
      lines.push(...this.renderSingleColumn(st, innerW, row, th));
    }

    // ── Footer ──
    lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
    const doneCount = Array.from(this.answers.keys()).length;
    const left =
      this.questions.length > 1
        ? th.fg("dim", ` ${doneCount}/${this.questions.length} answered · `)
        : th.fg("dim", " ");
    const hint = multi
      ? `${TOGGLE_HINT} collapse · ↑↓ move · Space toggle · Enter confirm · Esc cancel`
      : `${TOGGLE_HINT} collapse · ↑↓ move · Space select · Enter confirm · Esc cancel`;
    lines.push(row(`${left}${th.fg("dim", hint)}`));
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  /** Render the option row glyph. The cursor (▸) is independent of selection. */
  private optionGlyph(
    opt: RenderOption,
    index: number,
    st: TabState,
    multi: boolean,
    th: Theme,
    isCursor: boolean,
    customAnswered: boolean,
  ): string {
    if (opt.isOther) {
      // "Type something." is filled when a custom answer was committed.
      return customAnswered ? th.fg("success", ICON_RADIO_FILLED) : th.fg("dim", ICON_OTHER);
    }
    if (multi) {
      const checked = st.multiChecked.has(index);
      return checked ? th.fg("success", ICON_CHECK_FILLED) : th.fg("dim", ICON_CHECK_EMPTY);
    }
    // single: filled only when committed (selectedSingle), not on cursor hover
    const filled = st.selectedSingle === index;
    return filled ? th.fg("success", ICON_RADIO_FILLED) : th.fg("dim", ICON_RADIO_EMPTY);
  }

  /** Format an answer for the review summary. Delegates to describeAnswer
   *  (single source of truth), then wraps in the theme color + truncates. */
  private formatAnswerText(ans: Answer | undefined, maxW: number, th: Theme): string {
    const view = describeAnswer(ans);
    const text = truncForDisplay(view.text, maxW);
    return th.fg(view.color, text);
  }

  /** Clamp the review scroll offset so the cursor stays visible. The review
   *  list has N questions + 1 note entry, so the cursor may equal N. */
  private clampReviewScroll(): void {
    const total = this.questions.length + 1;
    if (total === 0) return;
    const viewH = this.reviewViewportH;
    if (this.reviewCursor < this.reviewScrollOffset) this.reviewScrollOffset = this.reviewCursor;
    else if (this.reviewCursor >= this.reviewScrollOffset + viewH)
      this.reviewScrollOffset = this.reviewCursor - viewH + 1;
    if (this.reviewScrollOffset < 0) this.reviewScrollOffset = 0;
  }

  /** Review summary: one question per entry (header + answer), plus a trailing
   *  "note to assistant" entry. Viewport scrolling reuses the option-screen
   *  layout primitives. */
  private renderReview(width: number, innerW: number, th: Theme): string[] {
    const lines: string[] = [];
    // Review uses a distinct border color (success/green) so it's visually
    // unmistakable as the review/confirm screen — not another question. The
    // question screen keeps the default "border" color.
    const bc: import("@earendil-works/pi-coding-agent").ThemeColor = "success";
    const row = (content: string) => th.fg(bc, "│") + padRight(content, innerW) + th.fg(bc, "│");
    lines.push(th.fg(bc, `╭${"─".repeat(innerW)}╮`));
    lines.push(row(this.renderTabBarContent(th)));
    lines.push(row(""));
    lines.push(row(` ${th.fg("accent", th.bold("Review your answers"))}`));
    lines.push(th.fg(bc, `├${"─".repeat(innerW)}┤`));
    const n = this.questions.length;
    const total = n + 1; // +1 for the note entry
    // Body indent (6 cols): questions and the note carry a 2-visible-col marker
    // (`1.` / `2.` … or `✎ ` for the note) right after the cursor, plus a
    // separator space, so every title starts at the same column. The body is
    // indented one past that so header vs content stay visually distinct —
    // previously the body sat at 5 cols and the note's icon pushed its title
    // out of alignment with the question titles.
    const bodyIndent = "      "; // 6 spaces
    const maxW = innerW - 2 - bodyIndent.length;
    this.reviewViewportH = Math.max(3, Math.min(total, 10));
    this.clampReviewScroll();
    const start = this.reviewScrollOffset;
    const end = Math.min(total, start + this.reviewViewportH);
    for (let i = start; i < end; i++) {
      const isCursor = i === this.reviewCursor;
      const prefix = isCursor ? `${th.fg("accent", ICON_CURSOR)} ` : "  ";
      const headerColor: import("@earendil-works/pi-coding-agent").ThemeColor = isCursor
        ? "accent"
        : "muted";
      // marker: a fixed 2-visible-col slot + 1 separator space, so every title
      // (questions + note) aligns regardless of icon width. `1.` is 2 cols;
      // the note's ✎ is 1 col, padded to `✎ ` (hence one extra space between
      // ✎ and its title — the deliberate tradeoff of this layout).
      // ── Note entry (index n): always last, two rows like a question. ──
      if (i === n) {
        // 空行分隔：note 是异类条目（附加留言，非问答），用空行和上方
        // 问答列表隔开。保持简单，不用点线/装饰。
        lines.push(row(""));
        const marker = th.fg(headerColor, `${ICON_OTHER} `);
        lines.push(row(` ${prefix}${marker} ${th.fg(headerColor, "Note to assistant")}`));
        const msg = this.messageText;
        if (msg) {
          const vw = visibleWidth(msg);
          const body = vw <= maxW ? msg : `${truncateToWidth(msg, maxW - 1, "")}…`;
          lines.push(row(`${bodyIndent}${th.fg("text", body)}`));
        } else {
          lines.push(row(`${bodyIndent}${th.fg("dim", "(optional — Space to add a note)")}`));
        }
        continue;
      }
      const q = this.questions[i]!;
      const ans = this.answers.get(q.tab);
      // Header row: cursor + marker + title.
      const marker = th.fg(headerColor, `${i + 1}.`);
      lines.push(row(` ${prefix}${marker} ${th.fg(headerColor, q.header)}`));
      // Answer row: reuse the description renderer's indent/wrap, fed the
      // formatted answer text. Skipped/custom/multi-select all flow through
      // formatAnswerText, so the coloring matches the option screen.
      const ansText = this.formatAnswerText(ans, maxW, th);
      lines.push(row(`${bodyIndent}${ansText}`));
    }
    if (total > this.reviewViewportH) {
      lines.push(
        row(th.fg("dim", `${bodyIndent}↑↓/PgUp/PgDn scroll · ${start + 1}-${end}/${total}`)),
      );
    }
    lines.push(th.fg(bc, `├${"─".repeat(innerW)}┤`));
    lines.push(row(th.fg("dim", " ↑↓ move · Space edit · Enter confirm · Esc cancel")));
    lines.push(th.fg(bc, `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  /** Note editor screen: reached from the review's note entry via Space. Uses
   *  the same success-bordered look as the review screen to signal it's part
   *  of the review flow, not a fresh question. */
  private renderMessageEditor(width: number, innerW: number, th: Theme): string[] {
    const lines: string[] = [];
    const bc: import("@earendil-works/pi-coding-agent").ThemeColor = "success";
    const row = (content: string) => th.fg(bc, "│") + padRight(content, innerW) + th.fg(bc, "│");
    lines.push(th.fg(bc, `╭${"─".repeat(innerW)}╮`));
    lines.push(row(` ${th.fg("accent", th.bold(`${ICON_OTHER} Note to assistant`))}`));
    lines.push(th.fg(bc, `├${"─".repeat(innerW)}┤`));
    for (const el of this.messageEditor.render(innerW - 2)) lines.push(row(` ${el}`));
    lines.push(th.fg(bc, `├${"─".repeat(innerW)}┤`));
    lines.push(row(th.fg("dim", " Esc back to review · Enter save note")));
    lines.push(th.fg(bc, `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  /** Single-column layout: option label + wrapped description below. */
  private renderSingleColumn(
    st: TabState,
    innerW: number,
    row: (s: string) => string,
    th: Theme,
  ): string[] {
    const q = this.currentQuestion()!;
    const multi = isMulti(q);
    const opts = this.currentOptions();
    const maxRows = Math.max(3, Math.min(opts.length, 10));
    this.optionViewportH = maxRows;
    this.clampScrollToCursor();
    const start = st.scrollOffset;
    const end = Math.min(opts.length, start + maxRows);
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      const opt = opts[i]!;
      const isCursor = i === st.cursor;
      const prefix = isCursor ? `${th.fg("accent", ICON_CURSOR)} ` : "  ";
      const ans = this.answers.get(q.tab);
      const committedCustom = multi ? st.customText : ans?.kind === "custom" ? ans.text : null;
      const customAnswered = !!committedCustom;
      const glyph = this.optionGlyph(opt, i, st, multi, th, isCursor, customAnswered);
      // For "Type something.", show the committed text instead of the placeholder.
      const displayLabel = opt.isOther && customAnswered ? committedCustom! : opt.label;
      const labelColor = isCursor
        ? "accent"
        : opt.isOther
          ? customAnswered
            ? "text"
            : "dim"
          : "text";
      const labelText = th.fg(labelColor, displayLabel);
      out.push(row(` ${prefix}${glyph} ${labelText}`));
      if (opt.description) {
        out.push(...this.renderDescription(opt.description, isCursor, innerW, row, th));
      }
    }
    if (opts.length > maxRows) {
      out.push(row(th.fg("dim", `     ↑↓/PgUp/PgDn scroll · ${start + 1}-${end}/${opts.length}`)));
    }
    return out;
  }

  /**
   * Two-column layout (options | preview), each half-width. Triggered when any
   * option of the question carries a `preview` field. The right pane shows the
   * preview of the option currently under the cursor.
   */
  private renderDualColumn(
    q: Question,
    st: TabState,
    innerW: number,
    row: (s: string) => string,
    th: Theme,
  ): string[] {
    const multi = isMulti(q);
    const opts = this.currentOptions();
    const halfW = Math.floor((innerW - 2) / 2); // 1-space gutter between columns
    const leftW = halfW;
    const rightW = innerW - 2 - halfW;
    const maxRows = Math.max(3, Math.min(opts.length, 10));
    this.optionViewportH = maxRows;
    this.clampScrollToCursor();
    const start = st.scrollOffset;
    const end = Math.min(opts.length, start + maxRows);

    // ── build left column lines (options) ──
    const leftLines: string[] = [];
    const dualAns = this.answers.get(q.tab);
    const dualCommittedCustom = multi
      ? st.customText
      : dualAns?.kind === "custom"
        ? dualAns.text
        : null;
    const customAnswered = !!dualCommittedCustom;
    for (let i = start; i < end; i++) {
      const opt = opts[i]!;
      const isCursor = i === st.cursor;
      const prefix = isCursor ? `${th.fg("accent", ICON_CURSOR)} ` : "  ";
      const glyph = this.optionGlyph(opt, i, st, multi, th, isCursor, customAnswered);
      const displayLabel = opt.isOther && customAnswered ? dualCommittedCustom! : opt.label;
      const labelColor = isCursor
        ? "accent"
        : opt.isOther
          ? customAnswered
            ? "text"
            : "dim"
          : "text";
      const labelLine = `${prefix}${glyph} ${th.fg(labelColor, displayLabel)}`;
      leftLines.push(truncateToWidth(labelLine, leftW - 1, ""));
    }
    if (opts.length > maxRows) {
      leftLines.push(
        th.fg("dim", truncateToWidth(`${start + 1}-${end}/${opts.length}`, leftW - 1, "")),
      );
    }

    // ── build right column lines (preview of cursor option) ──
    const rightLines: string[] = [];
    const cursorOpt = opts[st.cursor];
    if (cursorOpt?.preview) {
      // Render preview verbatim (preserve ASCII layout), truncate to rightW.
      for (const ln of cursorOpt.preview.split("\n")) {
        rightLines.push(th.fg("muted", truncateToWidth(ln, rightW - 1, "")));
      }
    } else {
      rightLines.push(th.fg("dim", truncateToWidth("(no preview)", rightW - 1, "")));
    }

    // ── merge columns side by side, padding the shorter one ──
    const rowCount = Math.max(leftLines.length, rightLines.length);
    const out: string[] = [];
    for (let r = 0; r < rowCount; r++) {
      const l = padRight(leftLines[r] ?? "", leftW);
      const rr = padRight(rightLines[r] ?? "", rightW);
      out.push(row(` ${l} ${rr}`));
    }
    return out;
  }

  /**
   * Render an option description in single-column mode. Multi-line (newline-
   * containing) descriptions render verbatim as a fixed-width block.
   */
  private renderDescription(
    description: string,
    selected: boolean,
    innerW: number,
    row: (s: string) => string,
    th: Theme,
  ): string[] {
    const indent = "     ";
    const color = selected ? "muted" : "dim";
    if (description.includes("\n")) {
      const maxW = innerW - 2 - indent.length;
      return description
        .split("\n")
        .map((ln) => row(`${indent}${truncateToWidth(th.fg(color, ln), maxW, "")}`));
    }
    return wrapTextWithAnsi(`${indent}${th.fg(color, description)}`, innerW - 2).map((w) => row(w));
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Result view — static card shown in the message stream after ask_user.
// Lets the user verify at a glance what they chose. Two states driven by
// options.expanded: collapsed = one-line summary, expanded = bordered card.
// Reuses AskUserPanel's visual language (same border glyphs, theme colors,
// ✓/⊘/○ status icons, ✎ for custom) so it reads as a continuation of the
// interaction, not a foreign element.
// ────────────────────────────────────────────────────────────────────────────

class AskUserResultView implements Component {
  private questions: ReadonlyArray<Pick<Question, "header" | "tab">>;
  private result: AskUserResult;
  private theme: Theme;
  private expanded = false;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    questions: ReadonlyArray<Pick<Question, "header" | "tab">>,
    result: AskUserResult,
    theme: Theme,
  ) {
    this.questions = questions;
    this.result = result;
    this.theme = theme;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded !== expanded) {
      this.expanded = expanded;
      this.cachedWidth = undefined;
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedLines = this.expanded ? this.renderCard(width) : this.renderCollapsed(width);
    return this.cachedLines;
  }

  /** Overall status → icon, color, and a short status phrase (plain text,
   *  no ANSI — callers wrap it in color). */
  private getStatus(): { icon: string; color: ThemeColor; phrase: string } {
    const total = this.questions.length;
    if (this.result.cancelled) {
      return {
        icon: "⊘",
        color: "warning",
        phrase: `Cancelled · ${this.result.answers.length}/${total} answered`,
      };
    }
    const anySkipped = this.result.answers.some((a) => a.kind === "skipped");
    return anySkipped
      ? { icon: "○", color: "accent", phrase: "Answers (some skipped)" }
      : { icon: "✓", color: "success", phrase: "Answers submitted" };
  }

  /** Format one answer for the card display. Delegates to describeAnswer. */
  private formatAnswer(ans: Answer | undefined): { text: string; color: ThemeColor } {
    return describeAnswer(ans);
  }

  private renderCollapsed(width: number): string[] {
    const th = this.theme;
    const { icon, color, phrase } = this.getStatus();
    const head = `${th.fg(color, icon)} ${th.fg(color, phrase)}`;
    const sep = th.fg("dim", ": ");
    const pairs = this.questions.map((q) => {
      const ans = this.result.answers.find((a) => a.tab === q.tab);
      return `${q.header}=${this.formatAnswer(ans).text}`;
    });
    const body = pairs.join(th.fg("dim", " · "));
    return [th.fg("dim", truncForDisplay(`${head}${sep}${body}`, width))];
  }

  private renderCard(width: number): string[] {
    const th = this.theme;
    const { icon, color, phrase } = this.getStatus();
    const lines: string[] = [];
    // Status line — icon + phrase in the status color. No border, no redundant
    // "Ask User" title (the tool-execution cell already renders the tool name
    // as its header above this component).
    lines.push(`${th.fg(color, icon)} ${th.fg(color, th.bold(phrase))}`);
    lines.push(""); // blank line separates status from the Q&A list

    // Each question: header on its own row, then one or more answer rows.
    // Rows are prefixed by a glyph indicating the answer TYPE, not a uniform
    // marker: option picks get an arrow (›), custom text gets a pencil (✎).
    // A multi-select with BOTH options and custom renders as TWO rows. Long
    // content wraps (wrapTextWithAnsi) so nothing is ever truncated/lost.
    const indent = "    "; // 4-space lead for answer rows
    const arrow = th.fg("dim", ICON_ANSWER);
    const pencil = th.fg("dim", ICON_OTHER);
    const answerRow = (glyph: string, text: string, textColor: ThemeColor) => {
      const lead = `${indent}${glyph} `;
      const w = Math.max(8, width - visibleWidth(lead));
      const wrapped = wrapTextWithAnsi(th.fg(textColor, text), w);
      const contIndent = " ".repeat(visibleWidth(lead));
      const out = [`${lead}${wrapped[0]}`];
      for (let i = 1; i < wrapped.length; i++) out.push(`${contIndent}${wrapped[i]}`);
      return out;
    };
    for (const q of this.questions) {
      const ans = this.result.answers.find((a) => a.tab === q.tab);
      lines.push(th.fg("muted", q.header));
      if (!ans) {
        lines.push(`${indent}${th.fg("dim", "(no answer)")}`);
      } else if (ans.kind === "skipped") {
        lines.push(`${indent}${th.fg("warning", "(skipped)")}`);
      } else if (ans.kind === "single") {
        lines.push(...answerRow(arrow, ans.option, "text"));
      } else if (ans.kind === "custom") {
        lines.push(...answerRow(pencil, ans.text, "text"));
      } else if (ans.kind === "multi") {
        if (ans.options.length === 0 && !ans.custom) {
          lines.push(`${indent}${th.fg("dim", "(none)")}`);
        } else {
          // Options row (arrow) + optional custom row (pencil) — two rows.
          if (ans.options.length > 0)
            lines.push(...answerRow(arrow, ans.options.join(", "), "text"));
          if (ans.custom) lines.push(...answerRow(pencil, ans.custom, "text"));
        }
      }
    }

    // Note — separated by a blank line, no border, no indent. A speech-bubble
    // glyph marks it as a free-form message, distinct from the Q&A answers.
    if (this.result.message) {
      lines.push("");
      const prefix = th.fg("accent", ICON_NOTE);
      const noteW = Math.max(8, width - visibleWidth(prefix) - 1);
      const wrapped = wrapTextWithAnsi(this.result.message, noteW);
      lines.push(`${prefix} ${wrapped[0]}`);
      for (let i = 1; i < wrapped.length; i++) lines.push(wrapped[i]);
    }
    return lines;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Extension entry
// ────────────────────────────────────────────────────────────────────────────

export default function askUserExtension(pi: ExtensionAPI) {
  pi.registerTool<typeof AskUserParams, AskUserResult>({
    name: "ask_user",
    label: "Ask User",
    description:
      'Ask the user one or more questions with options. Supports single-select (◎→◉) and multi-select (□→▣, space toggles). Every question always includes a \'Type something.\' row so the user can type a custom answer whenever none of the provided options fit — this is built in and cannot be disabled, so never assume the user is restricted to your listed options. The custom-input draft is preserved across tab switches, and a focused side panel shows extended detail (ASCII layouts, code, reasoning) when an option carries a `preview` field. Each option needs a short `label` + a `description` (shown beneath it); add a `preview` field only when a description can\'t fully convey the option. The panel is collapsible (Ctrl+\\). Use for clarifying requirements, getting preferences, or confirming decisions. Avoid using this to pick one item from a long list you just enumerated (e.g. "which of these 8 fixes should I start with?"): options are capped at a handful for a reason, and if the choice isn\'t a real either/or, present the list in a normal message and let the user reply freely, or just proceed with the highest-priority item — reserve ask_user for genuine decisions with a few distinct, mutually-exclusive paths. All displayed user-facing text should use the conversation\'s language. The result is returned as JSON: `{ "cancelled": bool, "answers": [{ "tab": <the question\'s tab>, ... }], "message"?: string }`. Each answer echoes the question\'s `tab` so you can correlate by key. Per answer only the relevant fields appear: single-select option pick → `answer`; single-select custom text → `custom`; multi-select option picks → `answers: [...]`; multi-select with custom → `answers` + `custom`; multi-select empty commit (skippable, submitted with nothing) → `answers: []`; Tab-skipped → `skipped: true`. `custom` is a sibling of `answer`/`answers`, never mixed in — it signals the user typed something outside the offered options. The optional top-level `message` is a free-form note the user can attach on the review screen (about overall direction, pacing, or anything beyond the specific questions); it is user-provided and out-of-band: you cannot set it via the parameters, and it may be absent; when present, treat it as high-priority context that can override or reframe the answers above it.',
    parameters: AskUserParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult("Error: UI not available (running in non-interactive mode)");
      }
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }

      const questions: Question[] = params.questions.map((q) => ({
        ...q,
        options: q.options.map((o) => ({ ...o })),
      }));

      const result = await ctx.ui.custom<AskUserResult>(
        (tui, theme, _kb, done) => {
          return new AskUserPanel(questions, tui, theme, {
            onResult: (r) => done(r),
          });
        },
        {
          // overlay:false renders the panel into pi's bottom editorContainer slot
          // (the same path ctx.ui.select()/input() take) instead of compositing a
          // screen overlay over everything. The chat transcript stays visible above
          // the panel and is scrollable via the terminal's native scrollback. See
          // "Layout" note at the top of this file for why overlay:true breaks
          // transcript scrolling.
          overlay: false,
        },
      );

      // ── Build the JSON payload returned to the LLM ──
      //
      // Structure is intentionally SYMMETRIC with the questions schema the LLM
      // authored (AskUserParams): each question carries a `tab` as its identity
      // key, and each answer echoes that same `tab`, so the LLM can correlate
      // answers back to its own questions by key with zero parsing effort. This
      // replaces the old `tab: answer` text format, which broke when a custom
      // answer contained a colon or newline (it could overwrite or collide with
      // adjacent lines).
      //
      // Field shape (only relevant fields are emitted — no noise):
      //   single-select, option picked : { tab, answer }
      //   single-select, custom typed  : { tab, custom }   // custom NOT in answer
      //   multi-select, options picked : { tab, answers: [...] }
      //   multi-select, options+custom : { tab, answers: [...], custom }
      //   multi-select, custom only    : { tab, custom }
      //   multi-select, empty commit   : { tab, answers: [] }   // NOT skipped
      //   any question, Tab-skipped    : { tab, skipped: true }
      //
      // `custom` gets its own key (rather than being mixed into answer/answers)
      // so the LLM can tell the user stepped outside the offered options — a
      // useful signal, not an anti-spoofing measure. The empty-message note is
      // omitted entirely ("user left no note" is noise the LLM doesn't need).
      const jsonAnswers = result.answers.map((a): Record<string, unknown> => {
        const out: Record<string, unknown> = { tab: a.tab };
        switch (a.kind) {
          case "skipped":
            out.skipped = true;
            break;
          case "single":
            out.answer = a.option;
            break;
          case "custom":
            out.custom = a.text;
            break;
          case "multi":
            out.answers = a.options;
            if (a.custom) out.custom = a.custom;
            break;
        }
        return out;
      });
      const payload: Record<string, unknown> = {
        cancelled: result.cancelled,
        answers: jsonAnswers,
      };
      if (result.message) payload.message = result.message;

      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: result,
      };
    },
    renderResult(result, options, theme, context) {
      // context.args.questions is the schema-static type; AskUserResultView
      // only needs header+tab, so the structural subtype is compatible.
      const questions = context.args?.questions ?? [];
      const details = result.details ?? { questions: [], answers: [], cancelled: true };
      const comp =
        context.lastComponent instanceof AskUserResultView
          ? context.lastComponent
          : new AskUserResultView(questions, details, theme);
      comp.setExpanded(options.expanded);
      return comp;
    },
  });
}
