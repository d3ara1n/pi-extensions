/**
 * PeekOverlay — the /peek TUI overlay (LOCAL consult / "aside").
 *
 * Asks THIS instance: serialize the main conversation + answer via the utility
 * model, read-after-burn. The user questions their own session without
 * disturbing the main agent.
 *
 * Layout (regions separated by `├───┤` dividers, closed at the bottom with
 * `╰───╯`). `margin:{bottom:2}` in overlayOptions keeps pi's own footer
 * (rendered at the terminal bottom, outside the overlay) visually separate:
 *
 *   ╭──────────────────────────────────────────────────────╮  top border
 *   │ peek (main agent: <activity>, turn N)                │  title
 *   ├──────────────────────────────────────────────────────┤
 *   │ <answer region: auto-height, scrollable, streaming>  │
 *   ├──────────────────────────────────────────────────────┤
 *   │ › <input or waiting…>                                │  composer
 *   ├──────────────────────────────────────────────────────┤
 *   │ model <utility>                   tokens <n>         │  status
 *   ├──────────────────────────────────────────────────────┤
 *   │ Esc close · ↑↓ scroll · Enter send                   │  hotkeys
 *   ╰──────────────────────────────────────────────────────╯  bottom border
 *
 * Auto-height: the answer region grows with content up to a cap derived from
 * the REAL terminal height (read via tui.terminal.rows). Once content exceeds
 * the cap, it scrolls (↑/↓) and auto-follows the tail while streaming.
 */

import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	getPeekAPI,
	type InvestigateResult,
	type MainAgentStatus,
} from "@d3ara1n/pi-peek";
import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";

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
}

type Mode = "input" | "asking";

/** Rows occupied by everything EXCEPT the answer region and composer:
 *  top border(1) + title(1) + 4 dividers(4) + status(1) + hotkeys(1) + bottom border(1) = 9.
 *  Composer rows are added dynamically when the input wraps. */
const FIXED_OVERHEAD_NO_COMPOSER = 9;
/** Composer rows cap so a huge paste doesn't push the answer region off-screen. */
const MAX_COMPOSER_LINES = 5;
/** Floor for the answer region so tiny terminals still show something. */
const MIN_BODY_ROWS = 4;

export class PeekOverlay {
	private tui: PeekTui;
	private theme: PeekTheme;
	private done: () => void;
	private ctx: ExtensionContext;
	private api = getPeekAPI();

	private mode: Mode = "input";
	private input = "";
	private history: HistoryItem[] = [];

	// asking state
	private stage = "";
	private askStart = 0;
	private streamText = "";

	// tracker (main agent's current activity, shown in the header)
	private tracker: MainAgentStatus | null = null;
	private trackerTimer: ReturnType<typeof setInterval> | null = null;

	// scroll
	private bodyLines: string[] = [];
	private scrollOffset = 0;
	private autoFollow = true;
	// composer: how many rows the composer occupies (≥1); set during render
	private composerRows = 1;

	// last utility model used (status line before the first answer)
	private lastUtilityModel: string | null = null;

	constructor(tui: PeekTui, theme: PeekTheme, done: () => void, ctx: ExtensionContext) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.ctx = ctx;
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
		// Scroll works in both modes — review history while waiting.
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoFollow = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			const max = Math.max(0, this.bodyLines.length - this.currentBodyHeight);
			this.scrollOffset = Math.min(max, this.scrollOffset + 1);
			if (this.scrollOffset >= max) this.autoFollow = true;
			this.tui.requestRender();
			return;
		}
		if (this.mode === "asking") return;
		if (matchesKey(data, "return")) {
			this.submit();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.input = this.input.slice(0, -1);
			this.tui.requestRender();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.input += data;
			this.tui.requestRender();
		}
	}

	private submit(): void {
		const q = this.input.trim();
		if (!q) return;

		this.input = "";
		this.mode = "asking";
		this.stage = "investigating";
		this.askStart = Date.now();
		this.streamText = "";
		this.history.push({ role: "user", text: q });
		this.autoFollow = true;
		this.tui.requestRender();

		this.api
			.investigate(q, {
				onStage: (s) => {
					this.stage = s;
					this.tui.requestRender();
				},
				onToken: (d) => {
					this.streamText += d;
					this.tui.requestRender();
				},
			})
			.then((result) => {
				this.history.push({
					role: "assistant",
					text: result.answer,
					usage: result.usage,
					model: result.model,
				});
				if (result.model) this.lastUtilityModel = result.model;
				this.mode = "input";
				this.streamText = "";
				this.autoFollow = true;
				this.tui.requestRender();
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				this.history.push({ role: "assistant", text: `Error: ${msg}` });
				this.mode = "input";
				this.streamText = "";
				this.autoFollow = true;
				this.tui.requestRender();
			});
	}

	private close(): void {
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
		// no cached render state
	}

	/**
	 * Answer region height for the current render.
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
		const row = (s: string) =>
			b("│") + truncateToWidth(s, innerW, "", true) + b("│");

		const divider = () => b("├") + b("─".repeat(innerW)) + b("┤");

		// ── rebuild body lines (history + live stream) ───────────────────
		// Wrap to innerW - 2 so a leading " " indent + the line fits in innerW.
		this.bodyLines = [];
		const wrapW = Math.max(10, innerW - 2);

		if (this.history.length === 0 && this.mode !== "asking") {
			// Welcome / placeholder so the body isn't an empty hole on first open.
			const welcome =
				"Ask anything about this session. peek answers from the current conversation context "
				+ "via the utility model — the main agent is never disturbed.";
			this.bodyLines.push(th.fg("dim", "aside · read-after-burn"));
			for (const ln of wrapTextWithAnsi(th.fg("dim", welcome), wrapW)) {
				this.bodyLines.push(ln);
			}
		} else {
			const recent = this.history.slice(-4);
			for (const h of recent) {
				const who =
					h.role === "user"
						? th.fg("accent", "you")
						: th.fg("success", "peek");
				this.bodyLines.push(who);
				for (const ln of wrapTextWithAnsi(h.text, wrapW)) {
					this.bodyLines.push(ln);
				}
			}
		}

		if (this.mode === "asking") {
			const elapsed = ((Date.now() - this.askStart) / 1000).toFixed(1);
			const label =
				this.stage === "done"
					? th.fg("success", "done")
					: this.stage === "error"
						? th.fg("error", "error")
						: th.fg("accent", "investigating");
			this.bodyLines.push(`${label}  ${th.fg("dim", `${elapsed}s`)}`);
			// Stream placeholder so the region doesn't look frozen before the
			// first token lands.
			const showing = this.streamText || th.fg("dim", "…");
			for (const ln of wrapTextWithAnsi(showing, wrapW)) {
				this.bodyLines.push(ln);
			}
		}

		// ── composer lines (calculated first — body height depends on it) ─
		const composerLines: string[] = [];
		if (this.mode === "asking") {
			composerLines.push(th.fg("dim", " waiting for reply…"));
		} else if (this.input.length > 0) {
			const prefix = ` ${th.fg("accent", "›")} `;
			const prefixW = visibleWidth(prefix);
			// -1 for the leading space that row() prepends
			const wrapW = Math.max(10, innerW - prefixW - 1);
			const indent = " ".repeat(prefixW);
			const wrapped = wrapTextWithAnsi(this.input, wrapW);
			for (let i = 0; i < wrapped.length && composerLines.length < MAX_COMPOSER_LINES; i++) {
				composerLines.push((i === 0 ? prefix : indent) + wrapped[i]);
			}
			if (wrapped.length > MAX_COMPOSER_LINES) {
				composerLines.push(indent + th.fg("dim", "…"));
			}
		} else {
			composerLines.push(
				` ${th.fg("accent", "›")} ${th.fg("dim", "ask anything about this session…")}`,
			);
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
			const turn =
				this.tracker.turn > 0 ? `, turn ${this.tracker.turn}` : "";
			titleInner = ` ${title} ${th.fg("dim", `(main agent: ${act}${turn})`)}`;
		} else {
			titleInner = ` ${title} ${th.fg("dim", "(main agent: unknown)")}`;
		}
		out.push(row(titleInner));

		// ── divider separating the title from the content region ────────
		out.push(divider());

		// ── answer region: auto-height, scrollable ──────────────────────
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

		// ── divider + status line (utility model + cumulative tokens) ──
		out.push(divider());
		const modelId = this.lastUtilityModel ?? "—";
		const totalTokens = this.history.reduce(
			(sum, h) => sum + (h.usage?.total ?? 0),
			0,
		);
		const tokensStr = totalTokens > 0 ? formatTokens(totalTokens) : "—";
		const leftInfo = `${th.fg("muted", "model")} ${th.fg("dim", modelId)}`;
		const rightInfo = `${th.fg("muted", "tokens")} ${th.fg("dim", tokensStr)}`;
		const gap = Math.max(
			1,
			innerW - 1 - visibleWidth(leftInfo) - visibleWidth(rightInfo),
		);
		out.push(row(` ${leftInfo}${" ".repeat(gap)}${rightInfo}`));

		// ── divider + hotkeys ───────────────────────────────────────────
		out.push(divider());
		const scrollHint =
			maxOffset > 0
				? ` ${th.fg("dim", "·")} ${th.fg("dim", `↑${this.scrollOffset} ↓${maxOffset - this.scrollOffset} scroll`)}`
				: "";
		const hotkeys =
			` ${th.fg("dim", "Esc close")}${scrollHint} ${th.fg("dim", "·")} ${th.fg("dim", "Enter send")}`;
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
