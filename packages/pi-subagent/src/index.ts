/**
 * pi-subagent — Role-based subagent orchestration with TUI rendering.
 *
 * Delegates tasks to specialized pi child processes with:
 * - Real-time progress streaming via TUI (tool calls, turns, elapsed time)
 * - AI-generated one-line summary for compact display (configurable role)
 * - All messages collected for expanded view (Ctrl+O)
 * - Accurate, concise output for the main model
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { SubagentConfig, SubagentDetails, SubagentResult, SubagentRole, ToolStatus, ActivityEntry } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { loadSubagentConfig } from "./config.ts";
import { BUILTIN_ROLES } from "./roles.ts";
import { spawnSubagent, getPiInvocation } from "./spawn.ts";
import * as os from "node:os";

// ── Helpers ────────────────────────────────────────────────────────

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: SubagentResult["usage"], model?: string): string {
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

type DisplayItem =
	| { type: "toolCall"; name: string; args: Record<string, any>; status?: ToolStatus }
	| { type: "thinking"; status?: ToolStatus };

/** Map the real-time activity log into renderable display items (in order). */
function buildDisplayItems(activityLog: ActivityEntry[]): DisplayItem[] {
	return activityLog.map((a) =>
		a.kind === "thinking"
			? { type: "thinking", status: a.status }
			: { type: "toolCall", name: a.toolName ?? "?", args: a.args ?? {}, status: a.status },
	);
}

function shortenPath(p: string): string {
	const home = os.homedir();
	if (process.platform === "win32") {
		return p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
	}
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: string, text: string) => string,
): string {
	switch (toolName) {
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
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return fg("accent", toolName) + fg("dim", ` ${preview}`);
		}
	}
}

/** Per-tool-call visual styling: prefix glyph + color function keyed by status. */
function statusStyle(
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
function formatThinking(
	status: ToolStatus | undefined,
	fg: (color: string, text: string) => string,
): string {
	if (status === "running") {
		return fg("accent", "\u25C7 thinking");
	}
	// done (or unknown) — dim past tense, solid diamond
	return fg("dim", "\u25C6 thought");
}

function renderDisplayItems(
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

function getFinalOutput(messages: SubagentResult["messages"]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text) return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(r: SubagentResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

// ── Summary generation ─────────────────────────────────────────────

async function generateSummary(
	rolesApi: ModelRolesAPI,
	outputText: string,
	summaryConfig: SubagentConfig["summary"],
): Promise<string | undefined> {
	if (!summaryConfig.enabled || !outputText.trim()) return undefined;

	try {
		const resolved = await rolesApi.resolveRoleAsync(summaryConfig.role);
		if (!resolved.model) return undefined;

		// Truncate large outputs to avoid wasting summary tokens (keep head + tail)
		const SUMMARY_MAX_INPUT = 4000;
		let summaryInput = outputText;
		if (summaryInput.length > SUMMARY_MAX_INPUT) {
			const half = Math.floor(SUMMARY_MAX_INPUT / 2);
			summaryInput = summaryInput.slice(0, half) + "\n\n... [truncated for summary] ...\n\n" + summaryInput.slice(-half);
		}

		const result = await complete(
			resolved.model,
			{
				systemPrompt:
					"Summarize the following agent output in one concise sentence (max 60 characters). Respond in the same language as the input. Focus on what was accomplished, not how. Output only the summary, no preamble.",
				messages: [{ role: "user", content: summaryInput, timestamp: Date.now() }],
			},
			{
				maxTokens: 100,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
			},
		);

		const text = result.content
			?.filter((block: any) => block.type === "text")
			?.map((block: any) => block.text)
			?.join("")
			?.trim();

		return text || undefined;
	} catch {
		// Fall back to manual truncation: use first line of output as summary
		const trimmed = outputText.trim();
		if (!trimmed) return undefined;
		const firstLine = trimmed.split("\n")[0];
		if (firstLine.length <= 65) return firstLine;
		return firstLine.slice(0, 62) + "...";
	}
}

// ── Extension entry ────────────────────────────────────────────────

export default function subagentExtension(pi: ExtensionAPI) {
	let config: SubagentConfig = DEFAULT_CONFIG;

	// If spawned as a child by a parent subagent, PI_SUBAGENT_ALLOWED restricts
	// which roles are available. Filter before any tool description sees them.
	const ALLOWLIST: string[] | undefined = (() => {
		const raw = process.env.PI_SUBAGENT_ALLOWED;
		if (!raw) return undefined;
		const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
		return list.length > 0 ? list : undefined;
	})();

	const availableRoles: Record<string, SubagentRole> = {};
	for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
		if (!ALLOWLIST || ALLOWLIST.includes(name)) {
			availableRoles[name] = role;
		}
	}

	// Mutable guidelines array — rebuilt in session_start to reflect agentOverrides
	const guidelines: string[] = [];

	function rebuildGuidelines(roles: Record<string, SubagentRole>): void {
		const entries = Object.entries(roles);
		const exampleLines: string[] = [];
		const decisionLines: string[] = [];

		for (const [name, role] of entries) {
			// Decision flow
			decisionLines.push(`  ${role.decisionTrigger} → delegate(${name})`);

			// Concrete examples — one line per role with comma-separated examples
			const quotedExamples = role.examples.map((e) => `"${e}"`).join(", ");
			exampleLines.push(`  delegate(${name}):  ${quotedExamples}`);
		}

		guidelines.length = 0;
		guidelines.push(
			"WHEN TO DELEGATE — offload substantial work when you only need the result:",
			"",
			"- Delegate ONLY when a task involves significant work (heavy analysis, multi-step investigation, large-scope changes) AND you only care about the conclusion, not intermediate steps.",
			"- DO NOT delegate simple tasks: a single read, a one-line edit, a basic grep. Just do them yourself.",
			"- DO NOT delegate straightforward file modifications touching 1-2 files. Use edit/write directly.",
			"- Delegation has overhead (spawning a child process). Reserve it for tasks that would genuinely clutter your context with 3+ turns of raw tool output.",
			"",
			"AVAILABLE ROLES:",
			...entries.map(([name, role]) => `  - ${name}: ${role.description}`),
			"",
			"DECISION FLOW (which role for what):",
			"",
			...decisionLines,
			"",
			"CONCRETE EXAMPLES of good delegation targets:",
			"",
			...exampleLines,
			"",
			"For multiple independent substantial tasks, emit multiple delegate calls in one turn — they run in parallel.",
			"Include ALL necessary context — subagents have no access to this conversation.",
		);
	}

	// Apply agent overrides on top of built-in roles
	function applyAgentOverrides(roles: Record<string, SubagentRole>, overrides: Record<string, any>): void {
		for (const [name, override] of Object.entries(overrides)) {
			if (override.disabled) {
				delete roles[name];
			} else if (roles[name]) {
				roles[name] = { ...roles[name], ...override };
			} else {
				// Custom role — must provide all required fields (validated in session_start)
				roles[name] = override as SubagentRole;
			}
		}
	}

	// Initial guidelines from built-in roles
	rebuildGuidelines(availableRoles);

	pi.on("session_start", async (_event, ctx) => {
		config = loadSubagentConfig(ctx.cwd);
		applyAgentOverrides(availableRoles, config.agentOverrides);

		// Validate custom roles (skip built-in roles — they already have all fields)
		const REQUIRED_FIELDS = ["role", "description", "examples", "decisionTrigger", "tools", "systemPrompt"] as const;
		for (const [name, role] of Object.entries(availableRoles)) {
			if (name in BUILTIN_ROLES) continue;
			const missing = REQUIRED_FIELDS.filter((f) => !(f in (role as any)));
			if (missing.length > 0) {
				delete availableRoles[name];
				ctx.ui.notify(
					`[pi-subagent] Custom role "${name}" skipped — missing: ${missing.join(", ")}. Required: ${REQUIRED_FIELDS.join(", ")}.`,
					"error",
				);
			}
		}

		rebuildGuidelines(availableRoles);
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate to subagent",
		description: "Offload work to a specialized subagent to keep your own context clean and focused. Prefer this over doing work yourself when a task would generate many tool calls or verbose output. Subagents have isolated context — include all necessary info in the task description.",
		promptSnippet: "Delegate tasks to specialized subagents",
		promptGuidelines: guidelines,

		parameters: Type.Object({
			role: Type.String({ description: "Subagent role to use" }),
			task: Type.String({ description: "Specific task for the subagent" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const roleDef = availableRoles[params.role];
			if (!roleDef) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown subagent role: ${params.role}. Available: ${Object.keys(availableRoles).join(", ")}`,
						},
					],
					details: undefined as any,
				};
			}

			// Resolve model from pi-model-roles
			let rolesApi: ModelRolesAPI;
			try {
				rolesApi = getModelRolesAPI();
			} catch {
				return {
					content: [{ type: "text", text: "pi-model-roles is not initialized. Cannot resolve model for subagent." }],
					details: undefined as any,
				};
			}

			const resolved = await rolesApi.resolveRoleAsync(roleDef.role);
			if (!resolved.model) {
				return {
					content: [{ type: "text", text: `Role "${roleDef.role}" could not be resolved. Model not available.` }],
					details: undefined as any,
				};
			}

			const modelRef = `${resolved.model.provider}/${resolved.model.id}`;
			const startTime = Date.now();

			// Emit initial placeholder for TUI
			if (onUpdate) {
				const placeholder: SubagentResult = {
					role: params.role,
					task: params.task,
					exitCode: -1,
					messages: [],
					output: "",
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					activityLog: [],
				};
				onUpdate({
					content: [{ type: "text", text: `${params.role}: running...` }],
					details: { mode: "single", results: [placeholder] },
				});
			}

			try {
				let result = await spawnSubagent(modelRef, params.task, {
					cwd: params.cwd ?? ctx.cwd,
					tools: roleDef.tools,
					systemPrompt: roleDef.systemPrompt,
					subagentRoles: roleDef.subagentRoles,
					timeoutMs: config.timeoutMs,
					signal,
					onProgress: (partial) => {
						if (!onUpdate) return;
						const elapsed = Math.round((Date.now() - startTime) / 1000);
						const liveResult: SubagentResult = {
							role: params.role,
							task: params.task,
							exitCode: -1,
							messages: partial.messages ?? [],
							output: partial.output ?? "",
							stderr: "",
							usage: partial.usage ?? {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								contextTokens: 0,
								turns: 0,
							},
							model: partial.model,
							stopReason: partial.stopReason,
							activityLog: partial.activityLog ?? [],
						};
						const statusText = `${params.role}  ${elapsed}s  ${liveResult.usage.turns} turn${liveResult.usage.turns !== 1 ? "s" : ""}`;
						onUpdate({
							content: [{ type: "text", text: statusText }],
							details: { mode: "single", results: [liveResult] },
						});
					},
				});

				// Retry with fallback role on provider errors (quota, auth, timeout, etc.)
				if ((result.exitCode !== 0 || result.errorMessage) && roleDef.fallbackRole) {
					const isProviderError = /429|quota|rate.?limit|auth|timeout|exhausted|unavailable/i.test(
						(result.stderr || "") + (result.errorMessage || ""),
					);
					if (isProviderError) {
						const fallback = await rolesApi.resolveRoleAsync(roleDef.fallbackRole);
						if (fallback.model) {
							const fbRef = `${fallback.model.provider}/${fallback.model.id}`;
							result = await spawnSubagent(fbRef, params.task, {
								cwd: params.cwd ?? ctx.cwd,
								tools: roleDef.tools,
								systemPrompt: roleDef.systemPrompt,
								subagentRoles: roleDef.subagentRoles,
								timeoutMs: config.timeoutMs,
								signal,
							});
						}
					}
				}

				// Generate summary for TUI display
				if (config.summary.enabled && result.output.trim()) {
					result.summary = await generateSummary(rolesApi, result.output, config.summary);
				}

				if (result.exitCode !== 0 || result.errorMessage) {
					return {
						content: [
							{
								type: "text",
								text: `Subagent (${params.role}) failed: ${result.errorMessage || result.stderr || "unknown error"}\n\nPartial output:\n${result.output}`,
							},
						],
						details: { mode: "single", results: [result] },
						isError: true,
					};
				}

				// Build concise output for the main model with usage info
				const usageParts: string[] = [];
				if (result.usage.turns) usageParts.push(`${result.usage.turns} turn${result.usage.turns > 1 ? "s" : ""}`);
				if (result.usage.input) usageParts.push(`\u2191${formatTokens(result.usage.input)}`);
				if (result.usage.output) usageParts.push(`\u2193${formatTokens(result.usage.output)}`);
				if (result.usage.cost) usageParts.push(`$${result.usage.cost.toFixed(4)}`);
				if (result.model) usageParts.push(result.model);
				const usageLine = usageParts.length > 0 ? `\n\n--- ${usageParts.join(" ")} ---` : "";

				return {
					content: [{ type: "text", text: result.output + usageLine }],
					details: { mode: "single", results: [result] },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Subagent (${params.role}) error: ${err.message || err}` }],
					details: { mode: "single", results: [] },
					isError: true,
				};
			}
		},

		// ── renderCall: what the user sees when the tool is invoked ──────

		renderCall(args, theme, _context) {
			const roleName = (args as any).role || "...";
			const task = (args as any).task || "";
			const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", roleName) +
				"\n  " +
				theme.fg("dim", preview);
			return new Text(text, 0, 0);
		},

		// ── renderResult: TUI display when the tool finishes ─────────────

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const r = details.results[0];
			const isRunning = r.exitCode === -1;
			const isError = !isRunning && isFailedResult(r);
			let icon: string;
			if (isRunning) {
				icon = theme.fg("warning", "\u23F3"); // hourglass
			} else if (isError) {
				icon = theme.fg("error", "\u2717");
			} else {
				icon = theme.fg("success", "\u2713");
			}
			const displayItems = buildDisplayItems(r.activityLog);
			const finalOutput = getFinalOutput(r.messages);
			const mdTheme = getMarkdownTheme();

			if (expanded) {
				const container = new Container();

				// Header
				let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.role))}`;
				if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				container.addChild(new Text(header, 0, 0));
				if (isError && r.errorMessage)
					container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));

				if (!isRunning) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Task \u2500\u2500\u2500"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
				}

				container.addChild(new Spacer(1));
				const activity = displayItems.filter((item) => item.type === "toolCall" || item.type === "thinking");
				if (activity.length === 0) {
					const runningLabel = isRunning ? "(waiting for first event...)" : "(none)";
					container.addChild(new Text(theme.fg("muted", runningLabel), 0, 0));
				} else {
					const fg = theme.fg.bind(theme) as (color: string, text: string) => string;
					for (const item of activity) {
						if (item.type === "thinking") {
							container.addChild(new Text(formatThinking(item.status, fg), 0, 0));
						} else {
							const { prefix, color } = statusStyle(item.status, fg);
							container.addChild(
								new Text(prefix + formatToolCall(item.name, item.args, color), 0, 0),
							);
						}
					}
				}

				if (!isRunning && finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}

				return container;
			}

			// Collapsed view
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.role))}`;

			if (isRunning) {
				// Running: show recent tool calls only
				const activity = displayItems.filter((item) => item.type === "toolCall" || item.type === "thinking");
				if (activity.length === 0) {
					text += `\n${theme.fg("muted", "(running...)")}`;
				} else {
					const rendered = renderDisplayItems(activity, 5, theme.fg.bind(theme) as (color: string, text: string) => string);
					if (rendered) text += `\n${rendered}`;
				}
			} else {
				// Finished: summary + usage, no tool calls
				if (r.summary) {
					text += ` ${theme.fg("dim", "\u00b7")} ${theme.fg("text", r.summary)}`;
				}
				if (isError) {
					const errMsg = r.errorMessage || (r.stderr ? r.stderr.trim().split("\n")[0].slice(0, 80) : r.stopReason);
					if (errMsg) text += `\n${theme.fg("error", `Error: ${errMsg}`)}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("subagent:doctor", {
		description: "Diagnose pi-subagent configuration and dependencies",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			let allOk = true;

			// 1. pi executable
			const inv = getPiInvocation(["--version"]);
			lines.push(`[\u2713] pi invocation: ${inv.command} ${inv.args.slice(0, 1).join(" ")}`);

			// 2. pi-model-roles
			try {
				const api = getModelRolesAPI();
				lines.push("[\u2713] pi-model-roles: loaded");

				// 3. config
				try {
					const cfg = loadSubagentConfig(ctx.cwd);
					lines.push(`[\u2713] config: timeout=${cfg.timeoutMs}ms summary=${cfg.summary.enabled ? cfg.summary.role : "off"}`);
				} catch {
					lines.push("[\u2717] config: failed to load");
					allOk = false;
				}

				// 4. roles
				for (const [name, role] of Object.entries(availableRoles)) {
					try {
						const resolved = await api.resolveRoleAsync(role.role);
						if (resolved.model) {
							lines.push(`[\u2713] role ${name}: \u2192 ${resolved.model.provider}/${resolved.model.id}`);
						} else {
							lines.push(`[\u2717] role ${name}: model not resolved (role config: ${role.role})`);
							allOk = false;
						}
					} catch {
						lines.push(`[\u2717] role ${name}: resolution failed`);
						allOk = false;
					}
				}
			} catch {
				lines.push("[\u2717] pi-model-roles: not initialized");
				allOk = false;
			}

			// 5. ALLOWLIST
			const allowed = process.env.PI_SUBAGENT_ALLOWED;
			if (allowed) {
				lines.push(`[i] PI_SUBAGENT_ALLOWED: ${allowed}`);
			}

			const summary = allOk ? "All checks passed" : "Some checks failed";
			ctx.ui.notify(`${summary}\n\n${lines.join("\n")}`, "info");
		},
	});
}
