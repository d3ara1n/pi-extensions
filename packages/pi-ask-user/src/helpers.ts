/**
 * Pure helpers for pi-ask-user: text sanitization, width-safe display
 * primitives, question introspection, and per-tab state construction.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { Editor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  type Answer,
  type AskUserResult,
  ICON_OTHER,
  type Question,
  type RenderOption,
  type TabState,
  type TuiLike,
} from "./types.ts";

export function wrapTab(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index % total) + total) % total;
}

/**
 * Normalize externally-supplied text for TUI rendering. Fold CR/CRLF into real
 * newlines, convert tabs to a single space, and strip remaining C0 control
 * chars (keeping only \n). Rationale: a raw \r returns the cursor to column 0
 * mid-row and clobbers leading indent; a raw \t advances to the next terminal
 * tab stop (which the panel's width math counts as 1 col, so rows overflow
 * their declared width and redraws accumulate stale copies); other C0 bytes
 * corrupt layout too. Callers then treat \n as the only meaningful break.
 */
export function sanitizeMultiline(text: string): string {
  // Build the control-char class from codepoints so no literal control bytes
  // appear in source (keeps biome's noControlCharactersInRegex happy). \x09
  // (tab) is handled separately below; \x0a (\n) is the one char we keep.
  const controls = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]", "g");
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(controls, "");
}

export function sanitizeTabDisplay(tab: string): string {
  return sanitizeMultiline(tab).replace(/\n/g, " ").trim() || "(unnamed)";
}

/** Build the full option list for a question, always appending the "Type something." custom-input row. */
export function buildOptions(q: Question): RenderOption[] {
  const opts: RenderOption[] = [...q.options];
  opts.push({ label: "Type something.", isOther: true });
  return opts;
}

export function isMulti(q: Question | undefined): boolean {
  return !!q?.multiSelect;
}

/** Whether the user is allowed to skip this question (default true). */
export function canSkip(q: Question | undefined): boolean {
  return q?.allowSkip !== false;
}

/** Does this question use the two-column (options | preview) layout? */
export function isDualColumn(q: Question | undefined): boolean {
  if (!q) return false;
  return q.options.some((o) => o.preview);
}

export function newTabState(
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

export function errorResult(
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
export function padRight(s: string, width: number): string {
  const v = visibleWidth(s);
  return v >= width ? s : s + " ".repeat(width - v);
}

/** Truncate to a visible width, appending “…” only when the text actually
 *  overflows. (truncateToWidth's third arg is a fill, not a suffix, so we
 *  reserve one column and append the ellipsis ourselves when needed.) */
export function truncForDisplay(text: string, maxW: number): string {
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
export interface AnswerView {
  /** Human-readable text WITHOUT ANSI — e.g. "Sidebar" / "甲, 乙" /
   *  "✎ 自定义文本" / "(none)" / "(skipped)". Consumers wrap it in color. */
  text: string;
  /** Theme color name for the whole text. */
  color: ThemeColor;
}

/** Interpret an Answer into display form. `customGlyph` (default "✎") prefixes
 *  any custom text. Returns `(no answer)` / dim for an absent answer. */
export function describeAnswer(ans: Answer | undefined, customGlyph = ICON_OTHER): AnswerView {
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
