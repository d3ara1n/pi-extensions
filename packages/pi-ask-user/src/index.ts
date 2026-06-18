/**
 * pi-ask-user — An ask-user tool for pi.
 *
 * Design notes:
 *   - Collapsible panel (Ctrl+\). Collapsing calls `handle.unfocus()` to release
 *     focus back to the editor. NOTE: because pi removes the editor from the UI
 *     tree while an overlay is active, full transcript scrolling while collapsed
 *     depends on pi behaviour; this is kept as a best-effort affordance.
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
 * Layout: bottom-anchored full-width overlay. Collapses to a single status row.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
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
	allowOther?: boolean;
	multiSelect?: boolean;
	allowSkip?: boolean;
}

interface Answer {
	tab: string;
	/** Single-select: the chosen label. Multi-select: empty string. */
	answerLabel: string;
	/** Multi-select: all chosen labels. Single-select: absent. */
	answerLabels?: string[];
	wasCustom: boolean;
	index?: number;
	/** True for multi-select answers. */
	multiSelect?: boolean;
	/** True if the user skipped this question (only set when allowSkip is true). */
	skipped?: boolean;
}

interface AskUserResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
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
	label: Type.String({ description: "Short display label for the option (shown on the selection row)" }),
	description: Type.Optional(
		Type.String({
			description: "Short explanation shown under the label (wraps). Add one when the label alone isn't self-explanatory.",
		}),
	),
	preview: Type.Optional(
		Type.String({
			description:
			"Only add this when `description` alone can't make the option clear — e.g. an ASCII layout demo, a code snippet, or detailed reasoning. Omit it otherwise; most options need only `description`. Triggers a side column when present.",
		}),
	),
});

const QuestionSchema = Type.Object({
	header: Type.String({
		description: "Short question title shown in the panel header, e.g. 'Which layout?'",
	}),
	tab: Type.String({
		description: "Short text shown on the tab bar for users to locate each question. Also serves as the answer key in the result. Prioritize readability for users over programmatic brevity — write in the user's language, e.g. \"Database\" or \"Layout\", not \"db_choice\". Must be unique across questions in one call." }),
	prompt: Type.Optional(
		Type.String({ description: "Optional longer body text shown under the header" }),
	),
	options: Type.Array(QuestionOptionSchema, {
		description: "Available options. Pass 2-4; each needs a short `label` + a `description`, and a `preview` only when a description can't fully convey the option.",
	}),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Allow a 'Type something.' custom-input option (default: true)" }),
	),
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

/** Build the full option list for a question, appending "Type something." if allowed. */
function buildOptions(q: Question): RenderOption[] {
	const opts: RenderOption[] = [...q.options];
	if (q.allowOther !== false) {
		opts.push({ label: "Type something.", isOther: true });
	}
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

function newTabState(tui: TuiLike, theme: EditorTheme, tabIndex: number, onSubmit: (tabIndex: number, value: string) => void): TabState {
	const editor = new Editor(tui as never, theme);
	editor.onSubmit = (value) => onSubmit(tabIndex, value);
	return { cursor: 0, scrollOffset: 0, inputMode: false, editor, multiChecked: new Set(), customText: null, selectedSingle: -1 };
}

function errorResult(message: string, questions: Question[] = []): {
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

// ────────────────────────────────────────────────────────────────────────────
// The overlay component
// ────────────────────────────────────────────────────────────────────────────

interface TuiLike {
	requestRender(): void;
}

interface PanelCallbacks {
	onResult: (result: AskUserResult) => void;
	onCollapseChange: (collapsed: boolean) => void;
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
	/** When true, the panel shows a review summary of all answers; Enter submits. */
	private reviewMode = false;
	/** Cursor row in the review summary. */
	private reviewCursor = 0;
	/** Vertical scroll offset for the review viewport. */
	private reviewScrollOffset = 0;
	/** Visible review rows (recomputed each render). */
	private reviewViewportH = 8;
	/** True after jumping from review mode to edit a question; makes answering
	 *  return to review instead of advancing to the next question. */
	private editingFromReview = false;

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
		this.tabs = questions.map((_, i) => newTabState(tui, editorTheme, i, (ti, v) => this.handleSubmit(ti, v)));
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
			st.customText = trimmed;
			this.commitMultiAnswer(q, st);
		} else {
			this.answers.set(q.tab, {
				tab: q.tab,
				answerLabel: trimmed,
				wasCustom: true,
			});
			st.selectedSingle = -2; // sentinel: "answered via type-something"
		}
		st.inputMode = false;
		if (tabIndex === this.currentTab) {
			this.advanceAfterAnswer();
		}
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
		const hasCustom = !!st.customText;
		if (hasCustom && st.customText) labels.push(st.customText);
		if (labels.length === 0) return false;
		this.answers.set(q.tab, {
			tab: q.tab,
			answerLabel: "",
			answerLabels: labels,
			wasCustom: hasCustom,
			multiSelect: true,
		});
		return true;
	}

	// ── accessors ──

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
		// If we came from review mode (editing a question), return to review
		// instead of advancing to the next question.
		if (this.editingFromReview) {
			this.editingFromReview = false;
			this.reviewMode = true;
			this.reviewScrollOffset = 0;
			this.invalidate();
			return;
		}
		if (this.currentTab < this.questions.length - 1) {
			this.switchTab(wrapTab(this.currentTab + 1, this.questions.length));
			return;
		}
		// Last question answered: enter review mode instead of submitting.
		this.reviewMode = true;
		this.reviewCursor = 0;
		this.reviewScrollOffset = 0;
		this.invalidate();
	}

	/**
	 * Called when the user tries to leave the current question without answering.
	 * - If the question is already answered: return true (leave freely).
	 * - If unanswered + allowSkip is true: record a skipped answer, return true.
	 * - If unanswered + allowSkip is false: return false (block navigation).
	 */
	private markSkippedIfNeeded(): boolean {
		const q = this.currentQuestion();
		if (!q) return true;
		if (this.answers.has(q.tab)) return true;
		if (!canSkip(q)) return false; // required question: block
		this.answers.set(q.tab, {
			tab: q.tab,
			answerLabel: "",
			wasCustom: false,
			skipped: true,
		});
		return true;
	}

	private submit(cancelled: boolean): void {
		this.cb.onResult({
			questions: this.questions,
			answers: Array.from(this.answers.values()),
			cancelled,
		});
	}

	private setCollapsed(next: boolean): void {
		if (this.collapsed === next) return;
		this.collapsed = next;
		this.cb.onCollapseChange(next);
		this.invalidate();
	}

	expandFromShortcut(): void {
		this.setCollapsed(false);
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
		if (matchesKey(data, TOGGLE_KEY)) {
			this.setCollapsed(!this.collapsed);
			return;
		}

		if (this.collapsed) {
			if (matchesKey(data, Key.escape)) this.submit(true);
			return;
		}

		// ── Review mode: list all answers, Enter submits, Tab/↑↓ jump to a question ──
		if (this.reviewMode) {
			return this.handleReviewInput(data);
		}

		const st = this.currentTabState();

		// "Type something." input mode: ALL editing keys (Tab, arrows, etc.) go to
		// the editor. Only Esc (exit) is handled here. Tab is NOT hijacked for
		// question switching — that would break indentation / cursor movement.
		// To switch questions, press Esc first to return to the option list.
		if (st.inputMode) {
			if (matchesKey(data, Key.escape)) {
				st.inputMode = false;
				// Keep the editor content (per-tab editor preserves it as draft).
				this.invalidate();
				return;
			}
			st.editor.handleInput(data);
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.submit(true);
			return;
		}

		const q = this.currentQuestion();
		if (!q) return;
		const opts = this.currentOptions();
		const multi = isMulti(q);

		// Tab navigation
		if (this.questions.length > 1) {
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				// Forward navigation: a required (allowSkip:false) question cannot be
				// left unanswered, so block + record-skip is gated on markSkippedIfNeeded.
				if (!this.markSkippedIfNeeded()) return;
				this.switchTab(wrapTab(this.currentTab + 1, this.questions.length));
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				// Backward navigation is always allowed — reviewing/editing earlier
				// questions doesn't let the user bypass a required question (forward
				// nav re-checks when they come back forward).
				this.switchTab(wrapTab(this.currentTab - 1, this.questions.length));
				return;
			}
		}

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

		// Multi-select: space toggles the option under the cursor
		if (multi && matchesKey(data, Key.space)) {
			const opt = opts[st.cursor];
			if (opt && !opt.isOther) {
				if (st.multiChecked.has(st.cursor)) st.multiChecked.delete(st.cursor);
				else st.multiChecked.add(st.cursor);
				this.invalidate();
			}
			return;
		}

		// Single-select: space commits the selection WITHOUT advancing (stay on question)
		if (!multi && matchesKey(data, Key.space)) {
			const opt = opts[st.cursor];
			if (opt && !opt.isOther) {
				st.selectedSingle = st.cursor;
				this.answers.set(q.tab, {
					tab: q.tab,
					answerLabel: opt.label,
					wasCustom: false,
					index: st.cursor,
				});
				this.invalidate();
			}
			return;
		}

		// Confirm
		if (matchesKey(data, Key.enter)) {
			const opt = opts[st.cursor];
			if (!opt) return;
			if (opt.isOther) {
				st.inputMode = true;
				// Prefill the editor with the committed custom text (if any) so the
				// user can edit rather than retype. Per-tab editor keeps the text
				// for Esc-discard semantics automatically.
				//   - Single-select: custom text lives in answers[].answerLabel.
				//   - Multi-select:  it lives in st.customText (kept alongside checks).
				const existing = this.answers.get(q.tab);
				const prefill = multi ? st.customText : existing?.wasCustom ? existing.answerLabel : null;
				if (prefill) st.editor.setText(prefill);
				this.invalidate();
				return;
			}
			if (multi) {
				if (!st.multiChecked.has(st.cursor)) st.multiChecked.add(st.cursor);
				// Re-commit merges checks + any previously entered custom text, so
				// going back to add/remove a check never drops the custom value.
				if (this.commitMultiAnswer(q, st)) this.advanceAfterAnswer();
				return;
			}
			// single-select: commit cursor position as the selection
			st.selectedSingle = st.cursor;
			this.answers.set(q.tab, {
				tab: q.tab,
				answerLabel: opt.label,
				wasCustom: false,
				index: st.cursor,
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

	/** Handle input while in review mode. */
	private handleReviewInput(data: string): void {
		const n = this.questions.length;
		if (matchesKey(data, Key.escape)) {
			this.submit(true);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			// Confirm: submit all answers.
			this.submit(false);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			// Jump to the question under the review cursor for editing.
			this.reviewMode = false;
			this.editingFromReview = true;
			this.switchTab(this.reviewCursor);
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.reviewCursor > 0) { this.reviewCursor--; this.invalidate(); }
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.reviewCursor < n - 1) { this.reviewCursor++; this.invalidate(); }
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.reviewCursor = Math.max(0, this.reviewCursor - Math.max(1, this.reviewViewportH));
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.reviewCursor = Math.min(n - 1, this.reviewCursor + Math.max(1, this.reviewViewportH));
			this.invalidate();
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
		const tabsPart = this.questions
			.map((q, i) => {
				const label = q.tab;
				const done = this.answers.has(q.tab);
				return th.fg(done ? "success" : "dim", `${label}${done ? "✓" : "○"}`);
			})
			.join(th.fg("dim", " "));
		const inner = `${tabsPart}  ${th.fg("dim", ` ${TOGGLE_HINT} expand `)}${th.fg("dim", " Esc cancel ")}`;
		const line =
			th.fg("border", "│") + inner + " ".repeat(Math.max(0, width - 2 - visibleWidth(inner))) + th.fg("border", "│");
		return [truncateToWidth(line, width)];
	}

	private renderExpanded(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const lines: string[] = [];
		const row = (content: string) => th.fg("border", "│") + padRight(content, innerW) + th.fg("border", "│");

		if (this.reviewMode) {
			return this.renderReview(width, innerW, row, th);
		}

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

		// ── Tab bar ──
		if (this.questions.length > 1) {
			const tabCells = this.questions.map((q, i) => {
				const label = q.tab;
				const active = i === this.currentTab;
				const ans = this.answers.get(q.tab);
				let mark = " ";
				let baseColor: import("@earendil-works/pi-coding-agent").ThemeColor = active ? "accent" : "muted";
				if (ans?.skipped) { mark = "—"; baseColor = "warning"; }
				else if (ans) { mark = "✓"; baseColor = "success"; }
				else if (active) mark = "▸";
				const color = active ? "accent" : baseColor;
				return th.fg(color, `${mark} ${label}`);
			});
			lines.push(row(` ${tabCells.join(th.fg("dim", "  "))}`));
			lines.push(row(""));
		}

		// ── Question header ──
		const q = this.currentQuestion();
		const multi = isMulti(q);
		const dual = isDualColumn(q);
		const progress = this.questions.length > 1 ? `  [${this.currentTab + 1}/${this.questions.length}]` : "";
		const tag = multi ? th.fg("dim", " (multi)") : "";
		const headerText = truncateToWidth(
			` ${th.fg("accent", th.bold(q?.header ?? ""))}${tag}${th.fg("dim", progress)}`,
			innerW,
			"",
		);
		lines.push(th.fg("border", "│") + padRight(headerText, innerW) + th.fg("border", "│"));

		// ── Prompt body ──
		if (q?.prompt) {
			for (const w of wrapTextWithAnsi(th.fg("muted", q.prompt), innerW - 2)) lines.push(row(` ${w}`));
			lines.push(row(""));
		}

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
			this.questions.length > 1 ? th.fg("dim", ` ${doneCount}/${this.questions.length} answered · `) : th.fg("dim", " ");
		const hint = multi
			? `${TOGGLE_HINT} collapse · ↑↓ move · Space toggle · Enter confirm · Esc cancel`
			: `${TOGGLE_HINT} collapse · ↑↓ move · Enter confirm · Esc cancel`;
		lines.push(row(`${left}${th.fg("dim", hint)}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	/** Render the option row glyph. The cursor (▸) is independent of selection. */
	private optionGlyph(opt: RenderOption, index: number, st: TabState, multi: boolean, th: Theme, isCursor: boolean, customAnswered: boolean): string {
		if (opt.isOther) {
			// "Type something." is filled when a custom answer was committed.
			return customAnswered
				? th.fg("success", ICON_RADIO_FILLED)
				: th.fg("dim", ICON_OTHER);
		}
		if (multi) {
			const checked = st.multiChecked.has(index);
			return checked ? th.fg("success", ICON_CHECK_FILLED) : th.fg("dim", ICON_CHECK_EMPTY);
		}
		// single: filled only when committed (selectedSingle), not on cursor hover
		const filled = st.selectedSingle === index;
		return filled ? th.fg("success", ICON_RADIO_FILLED) : th.fg("dim", ICON_RADIO_EMPTY);
	}

	/** Format an answer for the review summary: comma-joined, truncated with “…” if too long. */
	private formatAnswerText(ans: Answer | undefined, maxW: number, th: Theme): string {
		if (!ans) return th.fg("dim", "(no answer)");
		if (ans.skipped) return th.fg("warning", "(skipped)");
		let text: string;
		if (ans.multiSelect) text = (ans.answerLabels ?? []).join(", ");
		else text = ans.answerLabel;
		const vw = visibleWidth(text);
		if (vw <= maxW) return th.fg("text", text);
		// truncate: keep prefix, append “…”
		const cut = truncateToWidth(text, maxW - 1, "");
		return th.fg("text", cut) + th.fg("dim", "…");
	}

	/** Clamp the review scroll offset so the cursor stays visible. */
	private clampReviewScroll(): void {
		const n = this.questions.length;
		if (n === 0) return;
		const viewH = this.reviewViewportH;
		if (this.reviewCursor < this.reviewScrollOffset) this.reviewScrollOffset = this.reviewCursor;
		else if (this.reviewCursor >= this.reviewScrollOffset + viewH)
			this.reviewScrollOffset = this.reviewCursor - viewH + 1;
		if (this.reviewScrollOffset < 0) this.reviewScrollOffset = 0;
	}

	/** Review summary: one question per entry, header row + answer row, with
	 *  viewport scrolling reusing the option-screen layout primitives. */
	private renderReview(width: number, innerW: number, row: (s: string) => string, th: Theme): string[] {
		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", th.bold("Review your answers"))}`));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		const n = this.questions.length;
		this.reviewViewportH = Math.max(3, Math.min(n, 10));
		this.clampReviewScroll();
		const start = this.reviewScrollOffset;
		const end = Math.min(n, start + this.reviewViewportH);
		for (let i = start; i < end; i++) {
			const q = this.questions[i]!;
			const isCursor = i === this.reviewCursor;
			const ans = this.answers.get(q.tab);
			// Header row: cursor + label, same coloring as the option screen.
			const prefix = isCursor ? `${th.fg("accent", ICON_CURSOR)} ` : "  ";
			const headerColor = isCursor ? "accent" : "muted";
			lines.push(row(` ${prefix}${th.fg(headerColor, q.header)}`));
			// Answer row: reuse the description renderer's indent/wrap, fed the
			// formatted answer text. Skipped/custom/multi-select all flow through
			// formatAnswerText, so the coloring matches the option screen.
			const maxW = innerW - 2 - "     ".length;
			const ansText = this.formatAnswerText(ans, maxW, th);
			lines.push(row(`     ${ansText}`));
		}
		if (n > this.reviewViewportH) {
			lines.push(row(th.fg("dim", `     ↑↓/PgUp/PgDn scroll · ${start + 1}-${end}/${n}`)));
		}
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		lines.push(row(th.fg("dim", " ↑↓ navigate · Tab edit selected · Enter confirm · Esc cancel")));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	/** Single-column layout: option label + wrapped description below. */
	private renderSingleColumn(st: TabState, innerW: number, row: (s: string) => string, th: Theme): string[] {
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
			const committedCustom = multi ? st.customText : ans?.wasCustom ? ans.answerLabel : null;
			const customAnswered = !!committedCustom;
			const glyph = this.optionGlyph(opt, i, st, multi, th, isCursor, customAnswered);
			// For "Type something.", show the committed text instead of the placeholder.
			const displayLabel = opt.isOther && customAnswered ? committedCustom! : opt.label;
			const labelColor = isCursor ? "accent" : opt.isOther ? (customAnswered ? "text" : "dim") : "text";
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
		const dualCommittedCustom = multi ? st.customText : dualAns?.wasCustom ? dualAns.answerLabel : null;
		const customAnswered = !!dualCommittedCustom;
		for (let i = start; i < end; i++) {
			const opt = opts[i]!;
			const isCursor = i === st.cursor;
			const prefix = isCursor ? `${th.fg("accent", ICON_CURSOR)} ` : "  ";
			const glyph = this.optionGlyph(opt, i, st, multi, th, isCursor, customAnswered);
			const displayLabel = opt.isOther && customAnswered ? dualCommittedCustom! : opt.label;
			const labelColor = isCursor ? "accent" : opt.isOther ? (customAnswered ? "text" : "dim") : "text";
			const labelLine = `${prefix}${glyph} ${th.fg(labelColor, displayLabel)}`;
			leftLines.push(truncateToWidth(labelLine, leftW - 1, ""));
		}
		if (opts.length > maxRows) {
			leftLines.push(th.fg("dim", truncateToWidth(`${start + 1}-${end}/${opts.length}`, leftW - 1, "")));
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
			return description.split("\n").map((ln) => row(`${indent}${truncateToWidth(th.fg(color, ln), maxW, "")}`));
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
// Extension entry
// ────────────────────────────────────────────────────────────────────────────

export default function askUserExtension(pi: ExtensionAPI) {
	let activeExpand: (() => void) | null = null;

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Expand the ask-user panel (when collapsed)",
		handler: () => {
			activeExpand?.();
		},
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more questions with options. Supports single-select (◎→◉) and multi-select (□→▣, space toggles), per-question 'Type something.' custom input with draft preserved across tab switches, and a focused side panel for extended detail (ASCII layouts, code, reasoning) when an option carries a `preview` field. Each option needs a short `label` + a `description` (shown beneath it); add a `preview` field only when a description can't fully convey the option. The panel is collapsible (Ctrl+\\). Use for clarifying requirements, getting preferences, or confirming decisions. All displayed user-facing text should use the conversation's language.",
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
				allowOther: q.allowOther !== false,
				options: q.options.map((o) => ({ ...o })),
			}));

			let overlayHandle: { focus: () => void; unfocus: () => void } | null = null;
			let panel: AskUserPanel | null = null;

			const result = await ctx.ui.custom<AskUserResult>((tui, theme, _kb, done) => {
				panel = new AskUserPanel(questions, tui, theme, {
					onResult: (r) => done(r),
					onCollapseChange: (collapsed) => {
						if (collapsed) {
							overlayHandle?.unfocus();
							activeExpand = () => {
								if (!panel) return;
								panel.expandFromShortcut();
								overlayHandle?.focus();
							};
						} else {
							activeExpand = null;
							overlayHandle?.focus();
						}
					},
				});
				return panel;
			}, {
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: "100%",
					margin: { bottom: 0 },
				},
				onHandle: (handle) => {
					overlayHandle = handle;
					handle.focus();
				},
			});

			activeExpand = null;

			const summary = result.cancelled
				? `User cancelled the question(s). ${result.answers.length} question(s) were answered before cancellation.`
				: result.answers
						.map((a) => {
							if (a.skipped) return `${a.tab}: (skipped)`;
							if (a.multiSelect) return `${a.tab}: ${a.answerLabels?.join(", ") ?? ""}`;
							return `${a.tab}: ${a.wasCustom ? "(custom) " : ""}${a.answerLabel}`;
						})
						.join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: result,
			};
		},
	});
}
