/**
 * Shared types and icon constants for pi-ask-user.
 */

import { Key } from "@earendil-works/pi-tui";
import type { Editor } from "@earendil-works/pi-tui";

// ────────────────────────────────────────────────────────────────────────────
// Icon constants — all in U+25A0–25FF Geometric Shapes for font consistency
// ────────────────────────────────────────────────────────────────────────────

export const ICON_RADIO_EMPTY = "○"; // U+25CB white circle
export const ICON_RADIO_FILLED = "◉"; // U+25C9 fisheye
export const ICON_CHECK_EMPTY = "□"; // U+25A1
export const ICON_CHECK_FILLED = "▣"; // U+25A3
export const ICON_OTHER = "✎"; // pencil for "Type something."
export const ICON_CURSOR = "▸"; // current cursor position, independent of selection
export const ICON_NOTE = ICON_OTHER; // same ✎ pencil as custom answers — the note is also free-form user input
export const ICON_ANSWER = "›"; // lead glyph on option-pick answers in the result card

// ────────────────────────────────────────────────────────────────────────────
// Toggle key
// ────────────────────────────────────────────────────────────────────────────

/**
 * Collapse/expand toggle. Ctrl+\ (0x1c) is free in pi's built-in keybindings
 * (unlike Ctrl+] which collides with tui.editor.jumpForward) and is not used
 * as a prefix by tmux/zellij/screen/ssh.
 */
export const TOGGLE_KEY = Key.ctrl("\\");
export const TOGGLE_HINT = "Ctrl+\\";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface QuestionOption {
  label: string;
  description?: string;
  /** Rich preview shown in the right column when this option is focused. */
  preview?: string;
}

export interface RenderOption extends QuestionOption {
  isOther?: boolean;
}

export interface Question {
  /** Internal per-call identity. Never exposed in the tool's JSON result. */
  id: string;
  /** Original caller-provided key. Kept byte-for-byte for JSON results. */
  tab: string;
  /** Sanitized, non-empty label used exclusively by the TUI. */
  displayTab: string;
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
export type Answer =
  | { id: string; tab: string; kind: "single"; option: string }
  | { id: string; tab: string; kind: "custom"; text: string }
  | { id: string; tab: string; kind: "multi"; options: string[]; custom?: string }
  | { id: string; tab: string; kind: "skipped" };

export interface AskUserResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
  /** Free-form note the user can attach on the review screen. Absent when empty. */
  message?: string;
}

export interface PanelCallbacks {
  onResult: (result: AskUserResult) => void;
}

/** Per-tab ephemeral UI state. Preserved across tab switches. */
export interface TabState {
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
  /** Committed single-select index, or -1 if none yet. */
  selectedSingle: number;
}

/** Minimal TUI surface the panel/editors depend on. */
export interface TuiLike {
  requestRender(): void;
}
