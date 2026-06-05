/**
 * pi-scout — Per-turn side agent decision framework.
 *
 * Before each conversation turn, a cheap side agent model analyzes the user prompt
 * and decides:
 * 1. Which skills to inject (skill-router module)
 * 2. Whether to switch model roles (model-router module)
 *
 * Both modules can be independently toggled via /scout:* commands.
 * Scout progress and results are shown in the status bar.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ScoutConfig, ScoutDecision } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { loadScoutConfig } from "./config.ts";
import { callSideAgent } from "./side-agent.ts";
import { buildScoutSystemPrompt } from "./scout-prompt.ts";
import { filterSkillsBlock, resetSkillCache } from "./skill-inject.ts";
import { switchToRole } from "./model-switch.ts";

const STATUS_KEY = "scout";

/** Build a one-line status summary from a scout decision. */
function formatDecisionStatus(decision: ScoutDecision, theme: any): string {
	const parts: string[] = [];

	if (decision.skills.length > 0) {
		const names = decision.skills.length <= 3
			? decision.skills.join(", ")
			: `${decision.skills.slice(0, 2).join(", ")} +${decision.skills.length - 2}`;
		parts.push(theme.fg("accent", `skills: ${names}`));
	}
	if (decision.role) {
		parts.push(theme.fg("warning", `→ ${decision.role}`));
	}

	if (parts.length === 0) {
		return theme.fg("dim", "✓ scout: no changes");
	}

	return theme.fg("success", "✓ scout:") + " " + parts.join(" | ");
}

export default function scoutExtension(pi: ExtensionAPI) {
	let config: ScoutConfig = DEFAULT_CONFIG;
	let lastDecision: ScoutDecision | undefined;

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
			const theme = ctx.ui.theme;
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

	// ── list_skills tool ───────────────────────────────────────────
	let cachedAllSkills: Array<{ name: string; description: string; filePath: string }> = [];

	pi.registerTool({
		name: "list_skills",
		label: "List all skills",
		description: "List all available skills with name and description. Use this when the user asks what skills are installed or you need to discover skills beyond those currently active.",
		parameters: { type: "object", properties: {}, required: [] } as any,
		async execute() {
			if (cachedAllSkills.length === 0) {
				return { content: [{ type: "text", text: "No skills available." }] };
			}
			const lines = cachedAllSkills.map((s) => `- **${s.name}**: ${s.description}`);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});

	// ── session_start: load config ──────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		config = loadScoutConfig(ctx.cwd);
		resetSkillCache();
	});

	// ── Clear status at turn start ──────────────────────────────────
	pi.on("turn_start", async () => {
		// Will be overwritten by before_agent_start if scout runs
	});

	// ── before_agent_start: core scout logic ────────────────────────
	pi.on("before_agent_start", async (event, ctx) => {
		if (!config.enabled) return;
		if (!config.modules.skillRouter && !config.modules.modelRouter) return;

		let rolesApi: ModelRolesAPI;
		try {
			rolesApi = getModelRolesAPI();
		} catch {
			console.warn("[pi-scout] pi-model-roles not initialized — skipping scout");
			return;
		}

		const theme = ctx.ui.theme;

		// Show "Scouting..." indicator
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", "◎") + theme.fg("dim", " Scouting..."));

		// Resolve side agent model
		const sideResolved = await rolesApi.resolveRoleAsync(config.sideAgentRole);
		if (!sideResolved.model) {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "◎ scout: side model unavailable"));
			console.warn(`[pi-scout] Side agent role "${config.sideAgentRole}" not available — skipping`);
			return;
		}

		// Update status: resolving
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", "◎") + theme.fg("dim", ` Scouting via ${sideResolved.model.provider}/${sideResolved.model.id}...`));

		// 1. Get available skills from systemPromptOptions
		const skills = event.systemPromptOptions?.skills ?? [];
		if (cachedAllSkills.length === 0 && skills.length > 0) {
			cachedAllSkills = skills.map((s: any) => ({
				name: s.name,
				description: s.description ?? "",
				filePath: s.filePath,
			}));
		}
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
		const visibleRoles = rolesApi.getVisibleRoles();
		const rolesList = Object.entries(visibleRoles)
			.map(([name, cfg]: [string, any]) => `- ${name}: ${cfg.description ?? "(no description)"}${cfg.model ? ` (model: ${cfg.model})` : " (current model)"}`)
			.join("\n");
		const decision = await callSideAgent(
			sideResolved.model,
			sideResolved.apiKey,
			sideResolved.headers,
			scoutSystemPrompt,
			event.prompt,
			skillsList,
			currentRole,
			rolesList,
		);

		lastDecision = decision;

		let systemPrompt = event.systemPrompt;
		let switchedRole: string | undefined;

		// 4. skill-router: filter skills XML to only selected ones
		if (config.modules.skillRouter) {
			systemPrompt = filterSkillsBlock(
				systemPrompt,
				decision.skills,
				skills.map((s: any) => ({ name: s.name, description: s.description ?? "", filePath: s.filePath })),
			);
		}

		// 5. model-router: switch model if side agent recommends a different role
		if (config.modules.modelRouter && decision.role && decision.role !== currentRole) {
			const switched = await switchToRole(pi, decision.role, rolesApi);
			if (switched) {
				switchedRole = decision.role;
				const newModel = await rolesApi.resolveRoleAsync(decision.role);
				if (newModel?.model) {
					systemPrompt += `\n\n<current_model>${newModel.model.provider}/${newModel.model.id} (role: ${decision.role})</current_model>`;
				}
			}
		}

		// 6. Show result in status bar
		ctx.ui.setStatus(STATUS_KEY, formatDecisionStatus(decision, theme));

		// 7. Return modified system prompt
		if (systemPrompt !== event.systemPrompt) {
			return { systemPrompt };
		}
	});
}
