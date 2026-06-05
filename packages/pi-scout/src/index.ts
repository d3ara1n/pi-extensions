/**
 * pi-scout — Per-turn side agent decision framework.
 *
 * Before each conversation turn, a cheap side agent model analyzes the user prompt
 * and decides:
 * 1. Which skills to inject (skill-router module)
 * 2. Whether to switch model roles (model-router module)
 *
 * Both modules can be independently toggled via /scout:* commands.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ScoutConfig, ScoutDecision } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { loadScoutConfig } from "./config.ts";
import { callSideAgent } from "./side-agent.ts";
import { buildScoutSystemPrompt } from "./scout-prompt.ts";
import { stripSkillsBlock, readSkillContent } from "./skill-inject.ts";
import { switchToRole } from "./model-switch.ts";

export default function scoutExtension(pi: ExtensionAPI) {
	let config: ScoutConfig = DEFAULT_CONFIG;
	let lastDecision: ScoutDecision | undefined;

	/**
	 * Safely get ModelRolesAPI. Returns undefined if not initialized,
	 * with a user-visible notification.
	 */
	function tryGetRolesApi(ctx: ExtensionContext): ModelRolesAPI | undefined {
		try {
			return getModelRolesAPI();
		} catch {
			ctx.ui.notify(
				"pi-model-roles not loaded. Ensure @d3ara1n/pi-model-roles is in extensions and restart.",
				"error",
			);
			return undefined;
		}
	}

	// ── /scout — show status ────────────────────────────────────────
	pi.registerCommand("scout", {
		description: "Show scout status and last decision",
		handler: async (_args, ctx) => {
			const rolesApi = tryGetRolesApi(ctx);
			const sideRole = rolesApi?.getRole(config.sideAgentRole);
			const lines = [
				`Scout: ${config.enabled ? "enabled" : "disabled"}`,
				`Side agent role: ${config.sideAgentRole} (${sideRole?.model ?? "current model"})`,
				``,
				`Modules:`,
				`  skill-router: ${config.modules.skillRouter ? "on" : "off"}`,
				`  model-router: ${config.modules.modelRouter ? "on" : "off"}`,
			];

			if (lastDecision) {
				lines.push(``);
				lines.push(`Last decision:`);
				lines.push(`  skills: ${lastDecision.skills.length > 0 ? lastDecision.skills.join(", ") : "(none)"}`);
				lines.push(`  role: ${lastDecision.role ?? "(no change)"}`);
				lines.push(`  reasoning: ${lastDecision.reasoning}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── /scout:skill-router on/off ──────────────────────────────────
	pi.registerCommand("scout:skill-router", {
		description: "Toggle skill-router module (on/off)",
		handler: async (args, ctx) => {
			const value = (args ?? "").trim().toLowerCase();
			if (value === "on") {
				config.modules.skillRouter = true;
				ctx.ui.notify("Scout: skill-router enabled", "info");
			} else if (value === "off") {
				config.modules.skillRouter = false;
				ctx.ui.notify("Scout: skill-router disabled", "info");
			} else {
				ctx.ui.notify("Usage: /scout:skill-router on|off", "info");
			}
		},
	});

	// ── /scout:model-router on/off ──────────────────────────────────
	pi.registerCommand("scout:model-router", {
		description: "Toggle model-router module (on/off)",
		handler: async (args, ctx) => {
			const value = (args ?? "").trim().toLowerCase();
			if (value === "on") {
				config.modules.modelRouter = true;
				ctx.ui.notify("Scout: model-router enabled", "info");
			} else if (value === "off") {
				config.modules.modelRouter = false;
				ctx.ui.notify("Scout: model-router disabled", "info");
			} else {
				ctx.ui.notify("Usage: /scout:model-router on|off", "info");
			}
		},
	});

	// ── session_start: load config ──────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		config = loadScoutConfig(ctx.settings);
	});

	// ── before_agent_start: core scout logic ────────────────────────
	pi.on("before_agent_start", async (event, ctx) => {
		// Skip if disabled
		if (!config.enabled) return;

		// Both modules off → nothing to do
		if (!config.modules.skillRouter && !config.modules.modelRouter) return;

		let rolesApi: ModelRolesAPI;
		try {
			rolesApi = getModelRolesAPI();
		} catch {
			console.warn("[pi-scout] pi-model-roles not initialized — skipping scout");
			return;
		}

		// Resolve side agent model
		const sideResolved = await rolesApi.resolveRoleAsync(config.sideAgentRole);
		if (!sideResolved.model) {
			console.warn(`[pi-scout] Side agent role "${config.sideAgentRole}" not available — skipping`);
			return;
		}

		// 1. Get available skills from systemPromptOptions
		const skills = event.systemPromptOptions?.skills ?? [];
		const skillsList = skills
			.map((s: any) => `- ${s.name}: ${s.description ?? "(no description)"}`)
			.join("\n");

		// 2. Determine current role
		const currentModel = ctx.model;
		const currentRole = currentModel
			? (rolesApi.findRoleByModel(`${currentModel.provider}/${currentModel.id}`) ?? "unknown")
			: "unknown";

		// 3. Call side agent
		const scoutSystemPrompt = buildScoutSystemPrompt(config);
		const decision = await callSideAgent(
			sideResolved.model,
			sideResolved.apiKey,
			sideResolved.headers,
			scoutSystemPrompt,
			event.prompt,
			skillsList,
			currentRole,
		);

		lastDecision = decision;
		console.log(`[pi-scout] Decision: skills=${decision.skills.join(",") || "(none)"} role=${decision.role ?? "(no change)"} — ${decision.reasoning}`);

		let systemPrompt = event.systemPrompt;

		// 4. skill-router: intercept skills XML + inject selected skill content
		if (config.modules.skillRouter) {
			// Strip the default <available_skills> XML block
			systemPrompt = stripSkillsBlock(systemPrompt);

			// Inject full content of selected skills
			if (decision.skills.length > 0) {
				const skillContent = readSkillContent(
					decision.skills,
					skills.map((s: any) => ({ name: s.name, filePath: s.filePath })),
				);
				if (skillContent) {
					systemPrompt += skillContent;
				}
			}
		}

		// 5. model-router: switch model if side agent recommends a different role
		if (config.modules.modelRouter && decision.role && decision.role !== currentRole) {
			const switched = await switchToRole(pi, decision.role, rolesApi);
			if (switched) {
				console.log(`[pi-scout] Switched model to role "${decision.role}"`);
			}
		}

		// 6. Return modified system prompt
		if (systemPrompt !== event.systemPrompt) {
			return { systemPrompt };
		}
	});
}
