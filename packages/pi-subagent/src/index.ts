/**
 * pi-subagent — Role-based subagent orchestration.
 *
 * Provides a `delegate` tool that lets the main model delegate tasks
 * to specialized pi child processes with configurable model roles.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { Type } from "typebox";
import type { SubagentConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { loadSubagentConfig } from "./config.ts";
import { BUILTIN_ROLES } from "./roles.ts";
import { spawnSubagent } from "./spawn.ts";

export default function subagentExtension(pi: ExtensionAPI) {
	let config: SubagentConfig = DEFAULT_CONFIG;

	// Load config on session start
	pi.on("session_start", async (_event, ctx) => {
		config = loadSubagentConfig(ctx.settings);
	});

	// Register the delegate tool
	pi.registerTool({
		name: "delegate",
		label: "Delegate to subagent",
		description: [
			"Delegate a task to a specialized subagent with isolated context.",
			"Available roles:",
			"  - explorer: fast code search and navigation (read-only)",
			"  - reviewer: deep code review with evidence (read-only)",
			"  - worker: implementation with file editing capabilities",
			"  - researcher: web research and documentation lookup",
		].join("\n"),

		parameters: Type.Object({
			role: Type.Union([
				Type.Literal("explorer"),
				Type.Literal("reviewer"),
				Type.Literal("worker"),
				Type.Literal("researcher"),
			], { description: "Subagent role to use" }),
			task: Type.String({ description: "Specific task for the subagent" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const roleDef = BUILTIN_ROLES[params.role];
			if (!roleDef) {
				return {
					content: [{ type: "text", text: `Unknown subagent role: ${params.role}. Available: ${Object.keys(BUILTIN_ROLES).join(", ")}` }],
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

			try {
				const result = await spawnSubagent(modelRef, params.task, {
					cwd: params.cwd ?? ctx.cwd,
					tools: roleDef.tools,
					systemPrompt: roleDef.systemPrompt,
					timeoutMs: config.timeoutMs,
					signal,
				});

				if (result.exitCode !== 0 || result.errorMessage) {
					return {
						content: [{
							type: "text",
							text: `Subagent (${params.role}) failed: ${result.errorMessage || result.stderr || "unknown error"}\n\nPartial output:\n${result.output}`,
						}],
					};
				}

				// Format result with usage stats
				const usageParts: string[] = [];
				if (result.usage.turns) usageParts.push(`${result.usage.turns} turn${result.usage.turns > 1 ? "s" : ""}`);
				if (result.usage.input) usageParts.push(`↑${formatTokens(result.usage.input)}`);
				if (result.usage.output) usageParts.push(`↓${formatTokens(result.usage.output)}`);
				if (result.usage.cost) usageParts.push(`$${result.usage.cost.toFixed(4)}`);
				if (result.model) usageParts.push(result.model);

				const usageLine = usageParts.length > 0 ? `\n\n--- ${usageParts.join(" ")} ---` : "";

				return {
					content: [{ type: "text", text: result.output + usageLine }],
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Subagent (${params.role}) error: ${err.message || err}` }],
				};
			}
		},
	});
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
