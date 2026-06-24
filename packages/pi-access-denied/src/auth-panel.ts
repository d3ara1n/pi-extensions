/**
 * Authorization panel for pi-access-denied.
 *
 * A two-phase bottom-anchored overlay (paradigm borrowed from pi-ask-user's
 * `AskUserPanel`):
 *
 *   - "list"   — vertical list of out-of-bounds paths, each defaulting to
 *                `accept`. A SINGLE horizontal choice bar reflects the FOCUSED
 *                path's current choice; ←/→ change it (no wrap), Tab wraps.
 *                Non-default choices render a right-aligned status tag on
 *                their own path row (`[always-deny]`, etc.) — accept shows
 *                nothing, because accept is the no-op default and the whole
 *                UX revolves around finding the paths you want to change.
 *
 *   - "reason" — entered only when the submitted result contains a deny or
 *                always-deny. A single global reason editor. Esc returns to
 *                the list (fixing the old "Esc = silent no-reason deny" bug
 *                where dismissing the reason input committed a deny).
 *
 * Keyboard:
 *   ↑/↓       move path focus
 *   ←/→       change focused path's action (no wrap — stops at edges)
 *   Tab       change action (wraps: Always deny → Accept); Shift+Tab wraps back
 *   Enter     submit (→ reason phase if any deny, else passthrough)
 *   Esc       list: cancel whole authorization · reason: back to list
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AuthResult, Choice } from "./types.ts";

export interface TuiLike {
	requestRender(): void;
}

export interface AuthPanelCallbacks {
	onResult: (result: AuthResult) => void;
}

/** The four actions, in left-to-right bar order. */
const CHOICES: readonly Choice[] = ["accept", "always-accept", "deny", "always-deny"];

/** Human-readable labels for the horizontal bar (Title Case). */
const CHOICE_LABELS: Record<Choice, string> = {
	accept: "Accept",
	"always-accept": "Always accept",
	deny: "Deny",
	"always-deny": "Always deny",
};

/**
 * Right-aligned status tag on a path row (lowercase + hyphen). Empty for the
 * default (`accept`), since accept is the no-op baseline.
 */
const CHOICE_TAGS: Record<Choice, string> = {
	accept: "",
	"always-accept": "[always-accept]",
	deny: "[deny]",
	"always-deny": "[always-deny]",
};

/** Pad a string with trailing spaces to a visible width (ANSI-aware). */
function padRight(s: string, width: number): string {
	const v = visibleWidth(s);
	return v >= width ? s : s + " ".repeat(width - v);
}

export class AuthPanel implements Component, Focusable {
	focused = false;

	private paths: string[];
	private header: string;
	private tui: TuiLike;
	private theme: Theme;
	private cb: AuthPanelCallbacks;

	private phase: "list" | "reason" = "list";
	private cursor = 0;
	private scrollOffset = 0;
	private choices: Map<string, Choice>;
	private viewportH = 8;
	private reasonEditor: Editor;

	// render cache (cleared on every state change via invalidate())
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		paths: string[],
		header: string,
		tui: TuiLike,
		theme: Theme,
		cb: AuthPanelCallbacks,
	) {
		this.paths = paths;
		this.header = header;
		this.tui = tui;
		this.theme = theme;
		this.cb = cb;
		this.choices = new Map(paths.map((p) => [p, "accept" as Choice]));

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
		// Editor renders its own borderColor frame; the reason phase layers it
		// inside this panel's outer frame (same nesting as pi-ask-user's note
		// editor). `focused` must be true while editing so the hardware cursor
		// marker is emitted.
		this.reasonEditor = new Editor(tui as never, editorTheme);
		this.reasonEditor.onSubmit = (value) => this.submit(false, value);
	}

	// ── accessors ──

	private get currentChoice(): Choice {
		return this.choices.get(this.paths[this.cursor]!) ?? "accept";
	}

	private setChoice(c: Choice): void {
		this.choices.set(this.paths[this.cursor]!, c);
		this.invalidate();
	}

	private clampScroll(): void {
		const n = this.paths.length;
		if (n === 0) return;
		const viewH = this.viewportH;
		if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
		else if (this.cursor >= this.scrollOffset + viewH) this.scrollOffset = this.cursor - viewH + 1;
		if (this.scrollOffset < 0) this.scrollOffset = 0;
	}

	private submit(cancelled: boolean, reason?: string): void {
		this.reasonEditor.focused = false;
		this.cb.onResult({
			cancelled,
			choices: this.choices,
			reason: cancelled ? undefined : reason,
		});
	}

	// ── input ──

	handleInput(data: string): void {
		// Reason phase: the editor owns all editing keys. Esc returns to the
		// list (NOT a silent deny). Enter falls through to reasonEditor which
		// fires onSubmit → submit(false, value).
		if (this.phase === "reason") {
			if (matchesKey(data, Key.escape)) {
				this.reasonEditor.focused = false;
				this.phase = "list";
				this.invalidate();
				return;
			}
			this.reasonEditor.handleInput(data);
			this.invalidate();
			return;
		}

		// ── List phase ──

		// Esc = cancel the whole authorization (soft deny, "dismissed").
		if (matchesKey(data, Key.escape)) {
			this.submit(true);
			return;
		}

		const n = this.paths.length;

		// ↑/↓ — move path focus
		if (matchesKey(data, Key.up)) {
			if (this.cursor > 0) {
				this.cursor--;
				this.clampScroll();
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.cursor < n - 1) {
				this.cursor++;
				this.clampScroll();
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.cursor = Math.max(0, this.cursor - Math.max(1, this.viewportH));
			this.clampScroll();
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.cursor = Math.min(n - 1, this.cursor + Math.max(1, this.viewportH));
			this.clampScroll();
			this.invalidate();
			return;
		}

		const idx = CHOICES.indexOf(this.currentChoice);

		// ←/→ — change focused path's action, NO wrap (stops at the edges).
		if (matchesKey(data, Key.left)) {
			if (idx > 0) this.setChoice(CHOICES[idx - 1]!);
			return;
		}
		if (matchesKey(data, Key.right)) {
			if (idx < CHOICES.length - 1) this.setChoice(CHOICES[idx + 1]!);
			return;
		}
		// Tab — wraps forward (Always deny → Accept); Shift+Tab wraps backward.
		if (matchesKey(data, Key.tab)) {
			this.setChoice(CHOICES[(idx + 1) % CHOICES.length]!);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.setChoice(CHOICES[(idx - 1 + CHOICES.length) % CHOICES.length]!);
			return;
		}

		// Enter — submit. If any path is denied, collect a single global reason
		// first; otherwise passthrough directly (no reason prompt).
		if (matchesKey(data, Key.enter)) {
			const hasDeny = [...this.choices.values()].some((c) => c === "deny" || c === "always-deny");
			if (hasDeny) {
				this.phase = "reason";
				this.reasonEditor.focused = true;
				this.reasonEditor.setText("");
				this.invalidate();
			} else {
				this.submit(false);
			}
			return;
		}
	}

	// ── render ──

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.phase === "reason" ? this.renderReason(width) : this.renderList(width);
		return this.cachedLines;
	}

	private renderList(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const lines: string[] = [];
		const row = (content: string) => th.fg("border", "│") + padRight(content, innerW) + th.fg("border", "│");

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

		// Header
		lines.push(row(` ${th.fg("text", `${this.header} wants to reach outside the project allowlist:`)}`));
		lines.push(row(""));

		// Path list (scrolling viewport)
		const n = this.paths.length;
		this.viewportH = Math.max(3, Math.min(n, 10));
		this.clampScroll();
		const start = this.scrollOffset;
		const end = Math.min(n, start + this.viewportH);
		for (let i = start; i < end; i++) {
			lines.push(this.renderPathRow(i, innerW, th));
		}
		if (n > this.viewportH) {
			lines.push(row(th.fg("dim", ` ↑↓/PgUp/PgDn scroll · ${start + 1}-${end}/${n}`)));
		}

		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));

		// Choice bar — reflects the FOCUSED path's current choice.
		lines.push(this.renderChoiceBar(innerW, th));

		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		lines.push(row(th.fg("dim", " ↑↓ move path · ←→/Tab change action · Enter submit · Esc cancel")));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	/**
	 * One path row: leading cursor indicator + path (truncated) + right-aligned
	 * status tag. The tag is empty for the default (`accept`); a deny-class tag
	 * is red, an always-accept tag is green.
	 */
	private renderPathRow(i: number, innerW: number, th: Theme): string {
		const p = this.paths[i]!;
		const choice = this.choices.get(p) ?? "accept";
		const isCursor = i === this.cursor;
		const row = (content: string) => th.fg("border", "│") + padRight(content, innerW) + th.fg("border", "│");

		// 1 leading space + 2-col cursor indicator
		const prefix = isCursor ? `${th.fg("accent", "▸")} ` : "  ";
		const tag = CHOICE_TAGS[choice];
		const reserved = tag ? tag.length + 1 : 0; // +1 gap before tag
		const pathMaxW = Math.max(8, innerW - 3 - reserved); // 3 = 1 leading + 2 indicator

		const pathColor = isCursor ? th.fg("accent", th.bold(p)) : th.fg("dim", p);
		const pathStr = padRight(truncateToWidth(pathColor, pathMaxW, ""), pathMaxW);

		let tagPart = "";
		if (tag) {
			const isDeny = choice === "deny" || choice === "always-deny";
			tagPart = " " + (isDeny ? th.fg("error", tag) : th.fg("success", tag));
		}
		return row(` ${prefix}${pathStr}${tagPart}`);
	}

	/** The horizontal choice bar: ←  Accept  Always accept  Deny  Always deny  →.
	 *  The focused path's current choice is highlighted; deny-class highlights
	 *  in red, accept-class in accent. */
	private renderChoiceBar(innerW: number, th: Theme): string {
		const row = (content: string) => th.fg("border", "│") + padRight(content, innerW) + th.fg("border", "│");
		const current = this.currentChoice;
		const parts = CHOICES.map((c) => {
			const label = CHOICE_LABELS[c];
			if (c !== current) return th.fg("dim", label);
			const isDeny = c === "deny" || c === "always-deny";
			return isDeny ? th.fg("error", th.bold(label)) : th.fg("success", th.bold(label));
		});
		const arrowL = th.fg("dim", "←");
		const arrowR = th.fg("dim", "→");
		const bar = `${arrowL}   ${parts.join("   ")}   ${arrowR}`;
		return row(`  ${bar}`);
	}

	private renderReason(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const lines: string[] = [];
		const row = (content: string) => th.fg("border", "│") + padRight(content, innerW) + th.fg("border", "│");
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("text", "Reason for denying (optional, empty = default)")}`));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		// Editor draws its own accent frame; layer it inside the outer panel.
		for (const el of this.reasonEditor.render(innerW - 2)) lines.push(row(` ${el}`));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		lines.push(row(th.fg("dim", " Esc back to paths · Enter submit")));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}
}
