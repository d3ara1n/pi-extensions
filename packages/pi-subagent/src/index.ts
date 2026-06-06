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
import type { SubagentConfig, SubagentDetails, SubagentResult } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { loadSubagentConfig } from "./config.ts";
import { BUILTIN_ROLES } from "./roles.ts";
import { spawnSubagent } from "./spawn.ts";
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
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: SubagentResult["messages"]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text) items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall" && part.name)
					items.push({ type: "toolCall", name: part.name, args: part.arguments ?? {} });
			}
		}
	}
	return items;
}

function shortenPath(p: string): string {
	const home = os.homedir();
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
		if (item.type === "text") {
			const preview = item.text.split("\n").slice(0, 3).join("\n");
			text += `${fg("toolOutput", preview.length > 120 ? preview.slice(0, 120) + "..." : preview)}\n`;
		} else {
			text += `${fg("muted", "\u2192 ")}${formatToolCall(item.name, item.args, fg)}\n`;
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

		const result = await complete(
			resolved.model,
			{
				systemPrompt:
					"Summarize the following agent output in one concise Chinese sentence (max 60 characters). Focus on what was accomplished, not how. Output only the summary, no preamble.",
				messages: [{ role: "user", content: outputText }],
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
		return undefined;
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

	// For promptGuidelines: only list roles the LLM is allowed to use
	const roleGuidelines = Object.entries(availableRoles).map(([name, role]) => {
		switch (name) {
			case "explorer": return "  - explorer: READ-ONLY codebase exploration — locate files, grep symbols, trace imports, explain structures. Tools: read, find, grep, glob. NO bash, NO edits, NO web access.";
			case "reviewer": return "  - reviewer: READ-ONLY code review & analysis — audit code, assess architecture, review diffs. Tools: read, bash, grep, glob. Has bash (git diff/log, test runs). NO edits, NO web access.";
			case "worker": return "  - worker: the ONLY role that can MODIFY files — edit, write, refactor, fix, implement. Tools: read, bash, edit, write, grep, glob, delegate. Can delegate to explorer/researcher.";
			case "researcher": return "  - researcher: the ONLY role with WEB ACCESS — search docs, fetch pages, analyze GitHub repos. Tools: web_search, fetch_content, read, bash, delegate. Can clone repos & delegate to explorer.";
			default: return `  - ${name}: ${role.systemPrompt.split(".")[0]}`;
		}
	});

	const hasReadOnlyRoles = availableRoles.explorer || availableRoles.reviewer;
	const hasWorkerRole = !!availableRoles.worker;

	pi.on("session_start", async (_event, ctx) => {
		config = loadSubagentConfig(ctx.cwd);
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate to subagent",
		description: "Delegate a task to a specialized subagent with isolated context. Subagents have NO context from the current conversation — include all necessary context in the task description.",
		promptSnippet: "Delegate tasks to specialized subagents",
		promptGuidelines: [
			"Role selection — each role has a distinct tool set. Choose by the PRIMARY action required:",
			...roleGuidelines,
			"",
			"DECISION GUIDE (in priority order):",
			"  1. Task requires modifying files? → worker (the ONLY role with edit/write)",
			"  2. Task requires web search or external documentation? → researcher (the ONLY role with web access)",
			"  3. Task requires running git commands or tests? → reviewer (has bash; explorer does not)",
			"  4. Pure codebase exploration (read, grep, locate)? → explorer (lightweight, no bash)",
			...(hasReadOnlyRoles && hasWorkerRole ? [
				"",
				"CRITICAL: If the task involves modifying ANY file, you MUST use 'worker'. 'explorer' and 'reviewer' are READ-ONLY.",
				"",
				"AMBIGUOUS TASKS (e.g. 'optimize query performance'):",
				"  - 'find the cause' / 'investigate and report' → explorer or reviewer (read-only fact-finding)",
				"  - 'fix it' / 'investigate and fix' → worker (worker explores internally via delegate)",
			] : []),
			"For multiple independent subagent tasks, emit multiple `delegate` tool calls in the same turn — they run in parallel automatically.",
			"Subagents have NO context from the current conversation — include ALL necessary context in the task description.",
		],

		parameters: Type.Object({
			role: Type.Union(
				[
					Type.Literal("explorer"),
					Type.Literal("reviewer"),
					Type.Literal("worker"),
					Type.Literal("researcher"),
				],
				{ description: "Subagent role to use" },
			),
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
				};
			}

			// Resolve model from pi-model-roles
			let rolesApi: ModelRolesAPI;
			try {
				rolesApi = getModelRolesAPI();
			} catch {
				return {
					content: [{ type: "text", text: "pi-model-roles is not initialized. Cannot resolve model for subagent." }],
				};
			}

			const resolved = await rolesApi.resolveRoleAsync(roleDef.role);
			if (!resolved.model) {
				return {
					content: [{ type: "text", text: `Role "${roleDef.role}" could not be resolved. Model not available.` }],
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
				};
				onUpdate({
					content: [{ type: "text", text: `${params.role}: running...` }],
					details: { mode: "single", results: [placeholder] },
				});
			}

			try {
				const result = await spawnSubagent(modelRef, params.task, {
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
						};
						const statusText = `${params.role}  ${elapsed}s  ${liveResult.usage.turns} turn${liveResult.usage.turns !== 1 ? "s" : ""}`;
						onUpdate({
							content: [{ type: "text", text: statusText }],
							details: { mode: "single", results: [liveResult] },
						});
					},
				});

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
			const displayItems = getDisplayItems(r.messages);
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
				const toolCalls = displayItems.filter((item) => item.type === "toolCall");
				if (toolCalls.length === 0) {
					const runningLabel = isRunning ? "(waiting for first event...)" : "(none)";
					container.addChild(new Text(theme.fg("muted", runningLabel), 0, 0));
				} else {
					for (const item of toolCalls) {
						container.addChild(
							new Text(
								theme.fg("muted", "\u2192 ") +
									formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
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
				const toolCalls = displayItems.filter((item) => item.type === "toolCall");
				if (toolCalls.length === 0) {
					text += `\n${theme.fg("muted", "(running...)")}`;
				} else {
					const rendered = renderDisplayItems(toolCalls, 5, theme.fg.bind(theme));
					if (rendered) text += `\n${rendered}`;
				}
			} else {
				// Finished: summary + usage, no tool calls
				if (r.summary) {
					text += ` ${theme.fg("dim", "\u00b7")} ${theme.fg("text", r.summary)}`;
				}
				if (isError && r.errorMessage) {
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
