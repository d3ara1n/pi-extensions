/**
 * Pure helpers for pi-subagent: formatting, sanitization, formatting helpers,
 * and the concurrency semaphore. No pi-API or I/O dependencies — safe to unit-test.
 *
 * Extracted from index.ts so these can be exercised directly. index.ts imports
 * them; behavior is unchanged.
 */

import * as os from "node:os";
import type { ActivityEntry, SubagentRole, SubagentResult, ToolStatus } from "./types.ts";

/** Max output chars fed to the main model and the expanded TUI. Larger outputs are compressed (or truncated) to fit. */
export const MAX_OUTPUT_CHARS = 50_000;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: SubagentResult["usage"], model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`\u2191${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`\u2193${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export type DisplayItem =
	| { type: "toolCall"; name: string; args: Record<string, any>; status?: ToolStatus }
	| { type: "thinking"; status?: ToolStatus };

/** Map the real-time activity log into renderable display items (in order). */
export function buildDisplayItems(activityLog: ActivityEntry[]): DisplayItem[] {
	return activityLog.map((a) =>
		a.kind === "thinking"
			? { type: "thinking", status: a.status }
			: { type: "toolCall", name: a.toolName ?? "?", args: a.args ?? {}, status: a.status },
	);
}

export function shortenPath(p: string): string {
	const home = os.homedir();
	if (process.platform === "win32") {
		return p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
	}
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: string, text: string) => string,
): string {
	switch (toolName) {
		case "delegate": {
			const subRole = args.role as string | undefined;
			return fg("muted", "delegate ") + fg("accent", subRole ?? "...");
		}
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return fg("muted", "$ ") + fg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(rawPath));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return fg("muted", "grep ") + fg("accent", `/${pattern}/`) + fg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			return fg("muted", "find ") + fg("accent", pattern);
		}
		case "glob": {
			const pattern = (args.pattern || "*") as string;
			return fg("muted", "glob ") + fg("accent", pattern);
		}
		default: {
			const preview = previewArgs(args);
			return fg("accent", toolName) + (preview ? fg("dim", ` ${preview}`) : "");
		}
	}
}

/** Per-tool-call visual styling: prefix glyph + color function keyed by status. */
export function statusStyle(
	status: ToolStatus | undefined,
	fg: (color: string, text: string) => string,
): { prefix: string; color: (c: string, text: string) => string } {
	switch (status) {
		case "running":
			return { prefix: fg("accent", "\u2192 "), color: fg };
		case "failed":
			return { prefix: fg("error", "\u2717 "), color: (_c, text) => fg("error", text) };
		case "done":
		default:
			return { prefix: fg("dim", "\u2022 "), color: (_c, text) => fg("dim", text) };
	}
}

/** Render a thinking-block row: diamond glyph + label, colored by status.
 * Running = hollow diamond (unformed thought); done = solid diamond (settled). */
export function formatThinking(
	status: ToolStatus | undefined,
	fg: (color: string, text: string) => string,
): string {
	if (status === "running") {
		return fg("accent", "\u25C7 thinking");
	}
	// done (or unknown) — dim past tense, solid diamond
	return fg("dim", "\u25C6 thought");
}

export function renderDisplayItems(
	items: DisplayItem[],
	limit: number | undefined,
	fg: (color: string, text: string) => string,
): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "thinking") {
			text += `${formatThinking(item.status, fg)}\n`;
		} else {
			const { prefix, color } = statusStyle(item.status, fg);
			text += `${prefix}${formatToolCall(item.name, item.args, color)}\n`;
		}
	}
	return text.trimEnd();
}

export function isFailedResult(r: SubagentResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || r.stopReason === "timeout";
}

/** Heuristic: does this result look like a provider-side failure worth retrying on the fallback role? */
export function isProviderError(result: SubagentResult): boolean {
	const haystack = `${result.stderr || ""}\n${result.errorMessage || ""}`;
	return /429|quota|rate.?limit|auth|timeout|exhausted|unavailable|503|server error|temporary|declined|overloaded|econnreset|socket hang up|epipe|network|connection/i.test(haystack);
}

/** Shape-based preview for tools we don't have a dedicated formatter for. */
export function previewArgs(args: Record<string, unknown>): string {
	const command = args.command as string | undefined;
	if (command) return `$ ${command.length > 60 ? command.slice(0, 60) + "..." : command}`;
	const fp = (args.file_path || args.path) as string | undefined;
	if (fp) return shortenPath(fp);
	const url = args.url as string | undefined;
	if (url) return url.length > 60 ? url.slice(0, 60) + "..." : url;
	const query = (args.query || args.pattern || args.regex || args.search) as string | undefined;
	if (query) return `/${query.length > 60 ? query.slice(0, 60) + "..." : query}/`;
	const argsStr = JSON.stringify(args);
	return argsStr.length > 50 ? argsStr.slice(0, 50) + "..." : argsStr;
}

// ── Concurrency gate ───────────────────────────────────────────────

/**
 * Promise-based semaphore capping concurrent subagent spawns.
 * acquire() resolves immediately while under the limit, otherwise queues.
 * Pass an AbortSignal to cancel while waiting (rejects and removes the waiter).
 */
export class AsyncSemaphore {
	private active = 0;
	private waiters: Array<() => void> = [];
	private max: number;
	constructor(max: number) {
		this.max = max;
	}
	async acquire(signal?: AbortSignal): Promise<void> {
		if (this.active < this.max) {
			this.active++;
			return;
		}
		return new Promise<void>((resolve, reject) => {
			const wakeup = () => {
				signal?.removeEventListener("abort", onAbort);
				this.active++;
				resolve();
			};
			const onAbort = () => {
				signal?.removeEventListener("abort", onAbort);
				const idx = this.waiters.indexOf(wakeup);
				if (idx >= 0) this.waiters.splice(idx, 1);
				reject(new Error("aborted while waiting for concurrency slot"));
			};
			this.waiters.push(wakeup);
			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}
	release(): void {
		this.active = Math.max(0, this.active - 1);
		const next = this.waiters.shift();
		if (next) next();
	}
}

// ── Timeout policy ────────────────────────────────────────

/**
 * Effective per-role timeout. Roles that can `delegate` need headroom for
 * nested runs to complete, so when no explicit per-role timeout is set we
 * double the base. An explicit roleDef.timeoutMs is always honored as-is.
 */
export function effectiveTimeoutMs(roleDef: SubagentRole, baseTimeoutMs: number): number {
	const canDelegate = (roleDef.tools ?? []).includes("delegate");
	if (canDelegate && roleDef.timeoutMs == null) {
		return baseTimeoutMs * 2;
	}
	return roleDef.timeoutMs ?? baseTimeoutMs;
}

// ── Output truncation ────────────────────────────────────────

/** Strip path separators / traversal so sessionId/toolCallId can't escape the history dir. */
export function sanitizeFilename(s: string): string {
	return s.replace(/[^\w.-]/g, "_").replace(/^[.]+/, "") || "unknown";
}

/** Mechanical fallback: keep head (findings) + tail (summary), drop the middle. */
export function truncateOutput(t: string): string {
	const head = t.slice(0, 30_000);
	const tail = t.slice(-(MAX_OUTPUT_CHARS - 30_050));
	return `[Output truncated — ${t.length} chars total]\n\n${head}\n\n... [truncated] ...\n\n${tail}`;
}
