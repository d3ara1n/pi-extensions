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
 *   - Single-select icons (○→◉) and multi-select icons (□→▣) all live in the
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
 *   unscrollable.) Collapses to one status row.
 */

import type { ExtensionAPI, ExtensionUIContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  type KeyId,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  buildOptions,
  canSkip,
  describeAnswer,
  errorResult,
  isDualColumn,
  isMulti,
  newTabState,
  padRight,
  sanitizeMultiline,
  sanitizeTabDisplay,
  truncForDisplay,
  wrapTab,
} from "./helpers.ts";
import { AskUserParams } from "./schema.ts";
import {
  type Answer,
  type AskUserResult,
  ICON_ANSWER,
  ICON_CHECK_EMPTY,
  ICON_CHECK_FILLED,
  ICON_CURSOR,
  ICON_NOTE,
  ICON_OTHER,
  ICON_RADIO_EMPTY,
  ICON_RADIO_FILLED,
  type PanelCallbacks,
  type Question,
  type RenderOption,
  type TabState,
  type TuiLike,
} from "./types.ts";

import { DEFAULT_CONFIG, formatKeyId, loadConfig } from "./config.ts";

// ────────────────────────────────────────────────────────────────────────────
// The overlay component
// ────────────────────────────────────────────────────────────────────────────

class AskUserPanel implements Component, Focusable {
  focused = false;

  private questions: Question[];
  private theme: Theme;
  private tui: TuiLike;
  private cb: PanelCallbacks;
  /** KeyId for the collapse/expand toggle (user-configurable via settings). */
  private toggleKey: string;

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
  /** Dedicated editor for the note. Text input: Enter saves (like
   *  the per-question "Type something." editor). */
  private messageEditor: Editor;

  // ── render cache ──
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    questions: Question[],
    tui: TuiLike,
    theme: Theme,
    cb: PanelCallbacks,
    /** KeyId for the collapse/expand toggle; user-configurable via settings. */
    toggleKey: string = DEFAULT_CONFIG.toggleKey,
  ) {
    this.questions = questions;
    this.tui = tui;
    this.theme = theme;
    this.cb = cb;
    this.toggleKey = toggleKey;

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
    // draft, so tab switching needs no text shuttling.
    this.tabs = questions.map((_, i) =>
      newTabState(tui, editorTheme, i, (ti, v) => this.handleSubmit(ti, v)),
    );
    // Dedicated editor for the review-screen note. Enter saves the text,
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
        if (!this.commitMultiAnswer(q, st)) this.answers.delete(q.id);
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
      // Enter on an option to confirm the whole question.
      st.customText = trimmed;
      this.commitMultiAnswer(q, st);
      st.inputMode = false;
      if (tabIndex === this.currentTab) this.invalidate();
      return;
    }
    this.answers.set(q.id, {
      id: q.id,
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
      id: q.id,
      tab: q.tab,
      kind: "multi",
      options: labels,
    };
    if (customText) ans.custom = customText;
    this.answers.set(q.id, ans);
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
   * Called before navigating FORWARD from a question tab (Tab/→ only).
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
    if (this.answers.has(q.id)) return true;
    const st = this.currentTabState();
    // Multi-select: uncommitted checks count as an answer — commit them,
    // then leave. commitMultiAnswer only returns false when there's nothing
    // to commit (no checks, no custom), which the guard already rules out.
    if (isMulti(q) && (st.multiChecked.size > 0 || !!st.customText)) {
      this.commitMultiAnswer(q, st);
      return true;
    }
    if (!canSkip(q)) return false; // required question, nothing chosen: block
    this.answers.set(q.id, {
      id: q.id,
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
    if (matchesKey(data, this.toggleKey as KeyId)) {
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
      this.handleReviewInput(data);
      return;
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
        const existing = this.answers.get(q.id);
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
      this.answers.set(q.id, {
        id: q.id,
        tab: q.tab,
        kind: "single",
        option: opt.label,
      });
      this.invalidate();
      return;
    }

    // Enter — confirm + advance. Space owns editing; Enter commits what's at
    // the cursor. Single-select commits the cursor option and advances;
    // multi-select commits the currently checked options as-is and advances
    // (Space owns checking; Enter commits the existing checks without toggling the cursor option).
    // One exception: on the single-select custom row, Enter opens the editor
    // if no custom answer is committed yet (engaging the custom option).
    if (matchesKey(data, Key.enter)) {
      const opt = opts[st.cursor];
      if (!opt) return;
      if (opt.isOther && !multi) {
        // Single-select isOther: if a custom answer is already committed,
        // advance; otherwise open the editor to type one. Space also opens the
        // editor, but Enter on the custom row should engage the custom option
        // rather than no-op when nothing's committed yet.
        if (this.answers.get(q.id)?.kind === "custom") {
          this.advanceAfterAnswer();
        } else {
          st.inputMode = true;
          this.invalidate();
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
          this.answers.set(q.id, {
            id: q.id,
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
      this.answers.set(q.id, {
        id: q.id,
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
      // No backward wrap to review: backward navigation isn't validated by
      // prepareQuestionForLeave, so wrapping Q0 → review would let a required
      // (allowSkip:false) question be skipped. Stop at the first question,
      // matching ← below.
      if (this.currentTab - 1 < 0) return true; // stop at first question
      this.switchTab(this.currentTab - 1);
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

  /** Build a bordered content row that ALWAYS fits innerW: truncateToWidth
   *  is the hard safety net (any content — LLM-generated headers, user-typed
   *  custom answers, tab names — is clamped so the TUI render can never crash
   *  on an over-wide line), padRight then fills short content to keep the
   *  right border aligned. Shared by every bordered screen so the width
   *  invariant holds uniformly. */
  private makeRow(th: Theme, borderColor: ThemeColor, innerW: number) {
    return (content: string) => {
      const fitted = truncateToWidth(content, innerW);
      return th.fg(borderColor, "│") + padRight(fitted, innerW) + th.fg(borderColor, "│");
    };
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
      const done = this.answers.has(q.id);
      const active = i === this.currentTab && !this.isReviewTab;
      const mark = active ? "▸" : done ? "✓" : "○";
      const color = active ? "accent" : done ? "success" : "dim";
      return th.fg(color, `${q.displayTab}${mark}`);
    });
    const reviewPart = this.isReviewTab ? th.fg("accent", "Review▸") : th.fg("dim", "Review○");
    const tabsPart = [...qParts, reviewPart].join(th.fg("dim", " "));
    const inner = `${tabsPart}  ${th.fg("dim", ` ${formatKeyId(this.toggleKey)} expand `)}${th.fg("dim", " Esc cancel ")}`;
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
      const ans = this.answers.get(q.id);
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
      // Always reserve one padding cell on each side so tab width is constant
      // across active/inactive (no horizontal jump when switching). Only the
      // active tab paints the bg, turning that reserved space into a pill.
      const cell = th.fg(color, ` ${mark} ${q.displayTab} `);
      return active ? th.bg("selectedBg", cell) : cell;
    });
    const reviewActive = this.isReviewTab;
    const reviewMark = reviewActive ? "▸" : " ";
    const reviewColor: import("@earendil-works/pi-coding-agent").ThemeColor = reviewActive
      ? "accent"
      : "muted";
    const reviewCellRaw = th.fg(reviewColor, ` ${reviewMark} [ Review ] `);
    const reviewCell = reviewActive ? th.bg("selectedBg", reviewCellRaw) : reviewCellRaw;
    const sep = th.fg("dim", "  │");
    return ` ${tabCells.join(th.fg("dim", "  "))}${sep}${reviewCell}`;
  }

  private renderExpanded(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(20, width - 2);
    const lines: string[] = [];
    const row = this.makeRow(th, "border", innerW);

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
    // 空行分隔 header/prompt 与 options，无条件添加。
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
    const doneCount = Array.from(this.answers.values()).filter((a) => a.kind !== "skipped").length;
    const left =
      this.questions.length > 1
        ? th.fg("dim", ` ${doneCount}/${this.questions.length} answered · `)
        : th.fg("dim", " ");
    const hint = multi
      ? `${formatKeyId(this.toggleKey)} collapse · ↑↓ move · Space toggle · Enter confirm · Esc cancel`
      : `${formatKeyId(this.toggleKey)} collapse · ↑↓ move · Space select · Enter confirm · Esc cancel`;
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
    customAnswered: boolean,
  ): string {
    if (opt.isOther) {
      // "Type something." is filled when a custom answer was committed. Match
      // the question's glyph family so multi-select stays on the check (□/▣)
      // family instead of jumping to the radio (○/◉) family like single-select.
      const filled = multi ? ICON_CHECK_FILLED : ICON_RADIO_FILLED;
      return customAnswered ? th.fg("success", filled) : th.fg("dim", ICON_OTHER);
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
  private renderReview(_width: number, innerW: number, th: Theme): string[] {
    const lines: string[] = [];
    // Review uses a distinct border color (success/green) so it's visually
    // unmistakable as the review/confirm screen — not another question. The
    // question screen keeps the default "border" color.
    const bc: import("@earendil-works/pi-coding-agent").ThemeColor = "success";
    const row = this.makeRow(th, bc, innerW);
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
    // indented one past that so header vs content stay visually distinct.
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
      const ans = this.answers.get(q.id);
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
  private renderMessageEditor(_width: number, innerW: number, th: Theme): string[] {
    const lines: string[] = [];
    const bc: import("@earendil-works/pi-coding-agent").ThemeColor = "success";
    const row = this.makeRow(th, bc, innerW);
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
      const ans = this.answers.get(q.id);
      const committedCustom = multi ? st.customText : ans?.kind === "custom" ? ans.text : null;
      const customAnswered = !!committedCustom;
      const glyph = this.optionGlyph(opt, i, st, multi, th, customAnswered);
      // For "Type something.", show the committed text instead of the placeholder.
      // Custom text is arbitrary-length user input — truncate to the label
      // column (the full text appears on the review screen and result card,
      // both of which wrap). Without this a long custom answer makes the row
      // exceed the terminal width and crashes the TUI render.
      const labelMaxW = Math.max(0, innerW - 5); // 1 lead + 2 prefix + 1 glyph + 1 space
      const displayLabel =
        opt.isOther && customAnswered ? truncForDisplay(committedCustom!, labelMaxW) : opt.label;
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
    const dualAns = this.answers.get(q.id);
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
      const glyph = this.optionGlyph(opt, i, st, multi, th, customAnswered);
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
    // description is already control-char-sanitized at ingress, so \n is the
    // only meaningful break here.
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
  private questions: ReadonlyArray<Pick<Question, "id" | "header" | "tab" | "prompt">>;
  private result: AskUserResult;
  private theme: Theme;
  private expanded = false;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    questions: ReadonlyArray<Pick<Question, "id" | "header" | "tab" | "prompt">>,
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
    const lines: string[] = [];
    // Overview row: status icon + phrase in the status color. It is a summary
    // HEADER, not a list entry — so the Q&A list beneath is indented + dimmed
    // to read as a subordinate block rather than a peer of the overview.
    lines.push(truncForDisplay(`${th.fg(color, icon)} ${th.fg(color, phrase)}`, width));
    const indent = "  ";
    for (const q of this.questions) {
      const ans = this.result.answers.find((a) => a.id === q.id);
      const av = this.formatAnswer(ans);
      // Header + separator stay dim; the answer keeps its semantic color
      // (e.g. warning for skipped) so status is still readable at a glance.
      const qPart = th.fg("dim", `${q.header} = `);
      const aPart = th.fg(av.color, av.text);
      lines.push(truncForDisplay(`${indent}${qPart}${aPart}`, width));
    }
    return lines;
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
      const ans = this.result.answers.find((a) => a.id === q.id);
      // Header: bold + text color so it reads as the question's subject. Muted
      // made it as easy to skim past as a tab label, which is why short headers
      // looked like bare tags. The prompt body — when present — sits directly
      // beneath in muted, giving the full question context needed to review.
      lines.push(truncateToWidth(th.fg("text", th.bold(q.header)), width));
      if (q.prompt) {
        const promptIndent = "  ";
        const promptW = Math.max(8, width - visibleWidth(promptIndent));
        for (const w of wrapTextWithAnsi(th.fg("muted", q.prompt), promptW)) {
          lines.push(`${promptIndent}${w}`);
        }
      }
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

/**
 * Dialog-based degradation for non-TUI sessions (RPC / ACP hosts).
 *
 * Feature mapping vs the TUI panel:
 *   - single-select  → ctx.ui.select(), labels with inline one-line descriptions
 *   - "Type something." → trailing "✎" option that opens ctx.ui.input();
 *     cancelling the input returns to the option list
 *   - allowSkip      → trailing "→ Skip" option (same default-true semantics)
 *   - multiSelect    → one confirm() per option (full multi semantics, just verbose)
 *   - message note   → only probed after a successful free-text input proves
 *     the host answers input() dialogs (ACP adapters like rivet-dev/pi-acp
 *     auto-cancel them; polling would spam the transcript)
 *
 * Lost versus the panel: previews/description layout (folded into labels),
 * mid-multi-select dismissal (confirm-false means "no", not "cancel"), and
 * the note when the host never answered a text input.
 */
const DIALOG_OTHER = "✎ Type something…";
const DIALOG_SKIP = "→ Skip this question";

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

async function dialogAsk(questions: Question[], ctx: { ui: ExtensionUIContext }): Promise<AskUserResult> {
  const answers: Answer[] = [];
  let cancelled = false;
  let inputWorks = false;

  outer: for (const question of questions) {
    const title = question.prompt ? `${question.header}: ${oneLine(question.prompt)}` : question.header;
    const skippable = canSkip(question);

    if (!isMulti(question)) {
      // Single-select: option labels (+ inline descriptions), then Skip / Other.
      const displays = question.options.map((o) =>
        o.description ? `${o.label} — ${oneLine(o.description)}` : o.label,
      );
      const options = [...displays];
      if (skippable) options.push(DIALOG_SKIP);
      options.push(DIALOG_OTHER);

      while (true) {
        const picked = await ctx.ui.select(title, options);
        if (picked === undefined) {
          cancelled = true;
          break outer;
        }
        if (picked === DIALOG_SKIP) {
          answers.push({ id: question.id, tab: question.tab, kind: "skipped" });
          continue outer;
        }
        if (picked === DIALOG_OTHER) {
          const text = await ctx.ui.input(question.header, "Type your answer…");
          if (text !== undefined && text.trim()) {
            inputWorks = true;
            answers.push({ id: question.id, tab: question.tab, kind: "custom", text: text.trim() });
            continue outer;
          }
          continue; // dismissed/unsupported input — back to the option list
        }
        const index = displays.indexOf(picked);
        if (index === -1) continue; // unknown value — re-show the menu
        answers.push({ id: question.id, tab: question.tab, kind: "single", option: question.options[index].label });
        continue outer;
      }
    }

    // Multi-select: inclusion confirm() per option preserves full multi
    // semantics. confirm-false is indistinguishable from dismissal, so an
    // all-no run commits as an empty selection ({answers: []}) — same shape
    // as the panel's empty commit.
    const pickedLabels: string[] = [];
    for (const option of question.options) {
      const yes = await ctx.ui.confirm(
        `${question.header} — include "${option.label}"?`,
        option.description ?? question.prompt ?? "",
      );
      if (yes) pickedLabels.push(option.label);
    }
    answers.push({ id: question.id, tab: question.tab, kind: "multi", options: pickedLabels });
  }

  const result: AskUserResult = { questions, answers, cancelled };
  if (!cancelled && inputWorks) {
    // Host has proven it answers text inputs — safe to probe for the note.
    const note = await ctx.ui.input("Note for the agent (optional)", "anything to add along with your answers…");
    if (note?.trim()) result.message = note.trim();
  }
  return result;
}

export default function askUserExtension(pi: ExtensionAPI) {
  pi.registerTool<typeof AskUserParams, AskUserResult>({
    name: "ask_user",
    label: "Ask User",
    description:
      'Ask the user one or more questions with options (single- or multi-select), for clarifying requirements, getting preferences, or confirming decisions. Reserve it for genuine decisions with a few distinct paths — options are capped at a handful, so don\'t use it to pick one item from a long list you just enumerated; present that in a normal message or just proceed with the highest-priority item. Every question always includes a built-in \'Type something.\' row (cannot be disabled), so never assume the user is restricted to your listed options. All displayed text should be in the conversation\'s language. Returns `{ cancelled, answers: [...] }`: each answer is keyed by the question\'s `tab`; fields vary by answer kind (option pick → `answer`, custom text → `custom`, multi-select picks → `answers: [...]`, skipped → `skipped: true`), and an optional user-attached `message` note may accompany the answers — treat it as high-priority context. Direct tool call only — not callable from codemode scripts: it is absent from the script\'s `tools` object.',
    parameters: AskUserParams,
    // Model-only: a blocking human dialog must not be nested inside a codemode script —
    // script teardown, timeout, or abort would cancel the pending dialog and lose the user's input.
    exposure: "model-only",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }

      // Sanitize every externally-supplied display string once at ingress:
      // strip control chars (a raw \r resets the terminal cursor to column 0
      // and clobbers indentation; other C0 bytes corrupt rows too). Downstream
      // renderers can then treat \n as the only meaningful break. `tab` is
      // retained byte-for-byte for the JSON payload but rendered through a
      // sanitized display-only label. Internal ids keep duplicate tabs apart.
      const questions: Question[] = params.questions.map((q, index) => ({
        ...q,
        id: `question-${index + 1}`,
        displayTab: sanitizeTabDisplay(q.tab),
        header: sanitizeMultiline(q.header),
        prompt: q.prompt === undefined ? undefined : sanitizeMultiline(q.prompt),
        options: q.options.map((o) => ({
          ...o,
          label: sanitizeMultiline(o.label),
          description: o.description === undefined ? undefined : sanitizeMultiline(o.description),
          preview: o.preview === undefined ? undefined : sanitizeMultiline(o.preview),
        })),
      }));
      // Collapse/expand toggle key is user-configurable via the `askUser`
      // settings block (default ctrl+\\). Loaded per call so edits apply
      // without a reload.
      const cfg = loadConfig(ctx.cwd);

      // Dual-track UI: TUI sessions get the full custom panel; RPC/ACP hosts
      // get dialog-based degradation via pi's extension_ui_request sub-protocol
      // (`ctx.mode`, not `ctx.hasUI` — hasUI is true in rpc mode but
      // ctx.ui.custom() silently returns undefined there). print/json have no
      // host either way: every dialog resolves cancelled and the payload comes
      // back `{cancelled: true}`, which the LLM contract already covers.
      const result =
        ctx.mode === "tui"
          ? await ctx.ui.custom<AskUserResult>(
              (tui, theme, _kb, done) => {
                return new AskUserPanel(questions, tui, theme, {
                  onResult: (r) => done(r),
                }, cfg.toggleKey);
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
            )
          : await dialogAsk(questions, ctx);

      // ── Build the JSON payload returned to the LLM ──
      //
      // Structure is intentionally SYMMETRIC with the questions schema the LLM
      // authored (AskUserParams): each question carries a `tab` as its identity
      // key, and each answer echoes that same `tab`, so the LLM can correlate
      // answers back to its own questions by key with zero parsing effort.
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
      // `tab` gets a deterministic occurrence suffix for duplicate caller
      // keys so every answer stays addressable without mutating the originals.
      const answerById = new Map(result.answers.map((answer) => [answer.id, answer]));
      const duplicateTabs = new Map<string, number>();
      const jsonAnswers = questions.flatMap((question): Record<string, unknown>[] => {
        const answer = answerById.get(question.id);
        if (!answer) return [];
        const count = (duplicateTabs.get(answer.tab) ?? 0) + 1;
        duplicateTabs.set(answer.tab, count);
        const out: Record<string, unknown> = {
          tab: count === 1 ? answer.tab : `${answer.tab}-${count}`,
        };
        switch (answer.kind) {
          case "skipped":
            out.skipped = true;
            break;
          case "single":
            out.answer = answer.option;
            break;
          case "custom":
            out.custom = answer.text;
            break;
          case "multi":
            out.answers = answer.options;
            if (answer.custom) out.custom = answer.custom;
            break;
        }
        return [out];
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
      // Pre-execute failures (schema validation rejected the arguments, tool
      // not found, etc.): the core skips execute() and emits an error result —
      // content carries the failure message, isError is true. Show the failure
      // headline in red (mirrors the built-in tools' error rendering) instead of
      // the AskUserResultView, which would default `cancelled` to true and
      // misrender a validation failure as "user cancelled".
      if (context.isError) {
        const block = result.content?.[0];
        const t = block?.type === "text" ? block.text.split("\n")[0] : "Error";
        return new Text(theme.fg("error", t), 0, 0);
      }
      // Rebuild the per-call ids used by the interactive panel. The static
      // tool arguments retain caller-supplied tabs only, while details carries
      // answers keyed by these stable ids.
      const questions = (context.args?.questions ?? []).map((question, index) => ({
        ...question,
        id: `question-${index + 1}`,
      }));
      // Field-level fallback: result.details may be a truthy partial object
      // (e.g. { cancelled: false }) whose .answers is undefined, which would
      // crash getStatus/renderCollapsed/renderCard with "Cannot read
      // properties of undefined (reading 'some')". Normalize every field.
      const raw = result.details ?? {};
      const details: AskUserResult = {
        questions: raw.questions ?? [],
        answers: raw.answers ?? [],
        cancelled: raw.cancelled ?? true,
        message: raw.message,
      };
      const comp =
        context.lastComponent instanceof AskUserResultView
          ? context.lastComponent
          : new AskUserResultView(questions, details, theme);
      comp.setExpanded(options.expanded);
      return comp;
    },
  });
}
