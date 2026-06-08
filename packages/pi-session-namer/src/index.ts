/**
 * pi-session-namer — Auto-name pi sessions using a cheap side agent.
 *
 * On the first user prompt of a new session, calls a lightweight side agent
 * to generate a concise session title, then sets it via pi.setSessionName().
 * Subsequent turns are skipped with near-zero overhead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { DEFAULT_CONFIG } from "./types.ts";
import type { SessionNamerConfig } from "./types.ts";
import { loadNamerConfig } from "./config.ts";
import { generateSessionName } from "./namer.ts";

export default function sessionNamerExtension(pi: ExtensionAPI) {
	let config: SessionNamerConfig = DEFAULT_CONFIG;
	let hasNamed = false;
	let lastPrompt = "";

	// ── session_start: load config, reset flag ──────────────────────
	pi.on("session_start", async (_event, _ctx) => {
		config = loadNamerConfig(_ctx.cwd);
		hasNamed = false;
		lastPrompt = "";

		// 如果会话已有名称（resume/fork/用户手动命名），不再自动命名
		const existingName = pi.getSessionName();
		if (existingName) {
			hasNamed = true;
		}
	});

	// ── before_agent_start: auto-name on first prompt ───────────────
	pi.on("before_agent_start", async (event, ctx) => {
		if (!config.enabled || hasNamed) return;

		// Cache prompt for /namer:rename
		lastPrompt = event.prompt;

		// Skip empty prompts (e.g. image-only messages)
		if (!event.prompt?.trim()) return;

		// 标记为已处理（无论后续成功与否，不重试）
		hasNamed = true;

		// 异步命名，不阻塞主 agent 启动
		(async () => {
			let rolesApi;
			try {
				rolesApi = getModelRolesAPI();
			} catch {
				console.warn("[pi-session-namer] pi-model-roles not initialized — skipping");
				return;
			}

			const resolved = await rolesApi.resolveRoleAsync(config.sideAgentRole);
			if (!resolved.model) {
				console.warn(`[pi-session-namer] Side agent role "${config.sideAgentRole}" not available — skipping`);
				return;
			}

			const name = await generateSessionName(
				resolved.model,
				resolved.apiKey,
				resolved.headers,
				config,
				event.prompt,
			);

			pi.setSessionName(name);
		})().catch((err) => console.warn("[pi-session-namer] naming failed:", err));
	});

	// ── /namer — show status ────────────────────────────────────────
	pi.registerCommand("namer", {
		description: "Show session namer status and config",
		handler: async (args, ctx) => {
			const value = (args ?? "").trim().toLowerCase();

			// Handle on/off toggles
			if (value === "on") {
				config.enabled = true;
				ctx.ui.notify("Session Namer: enabled", "info");
				return;
			}
			if (value === "off") {
				config.enabled = false;
				ctx.ui.notify("Session Namer: disabled", "info");
				return;
			}

			const currentName = pi.getSessionName();
			const lines = [
				`Session Namer: ${config.enabled ? "enabled" : "disabled"}`,
				`Side agent role: ${config.sideAgentRole}`,
				`Max length: ${config.maxLength}`,
				`Current name: ${currentName ?? "(none)"}`,
				`Has auto-named: ${hasNamed}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── /namer:rename — force regenerate ────────────────────────────
	pi.registerCommand("namer:rename", {
		description: "Regenerate session name from the last user prompt",
		handler: async (_args, ctx) => {
			if (!lastPrompt?.trim()) {
				ctx.ui.notify("No user prompt available to generate a name from.", "warning");
				return;
			}

			let rolesApi;
			try {
				rolesApi = getModelRolesAPI();
			} catch {
				ctx.ui.notify("pi-model-roles not initialized. Cannot rename.", "error");
				return;
			}

			const resolved = await rolesApi.resolveRoleAsync(config.sideAgentRole);
			if (!resolved.model) {
				ctx.ui.notify(
					`Side agent role "${config.sideAgentRole}" not available. Cannot rename.`,
					"error",
				);
				return;
			}

			const name = await generateSessionName(
				resolved.model,
				resolved.apiKey,
				resolved.headers,
				config,
				lastPrompt,
			);

			pi.setSessionName(name);
			ctx.ui.notify(`Session renamed: ${name}`, "info");
		},
	});
}
