/**
 * pi-access-denied — sandbox write/edit/bash to the project directory.
 *
 * Gates built-in `write`, `edit`, and `bash` tools so they cannot reach paths
 * outside an allowlist (cwd + configured extra dirs) without authorization.
 *
 * Three modes (switchable at runtime via `/access-denied`):
 *   - prompt: ask the user; choices are accept / always-accept / deny / always-deny
 *   - deny:   block any out-of-bounds access outright
 *   - allow:  passthrough (effectively disable the gate)
 *
 * "Always" decisions are remembered per normalized target path for the current
 * session only — restarting pi (or `/reload`, `/new`, `/resume`) forgets them.
 */

import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.ts";
import { buildAllowlist, extractBashViolations, isOutsideAllowlist, isSafe, resolveTarget } from "./paths.ts";
import { DEFAULT_CONFIG, type AccessMode, type Decision } from "./types.ts";

const GLOBAL_KEY = "__piAccessDenied";
const STATUS_KEY = "access-denied";

interface SessionState {
	mode: AccessMode;
	config: typeof DEFAULT_CONFIG;
	alwaysAllow: Set<string>;
	alwaysDeny: Map<string, string>; // path -> reason
	alive: boolean;
}

function getState(): SessionState {
	const g = globalThis as Record<symbol | string, unknown>;
	if (!g[GLOBAL_KEY]) {
		g[GLOBAL_KEY] = {
			mode: DEFAULT_CONFIG.mode,
			config: DEFAULT_CONFIG,
			alwaysAllow: new Set<string>(),
			alwaysDeny: new Map<string, string>(),
			alive: false,
		} satisfies SessionState;
	}
	return g[GLOBAL_KEY] as SessionState;
}

// ── UI helpers ────────────────────────────────────────────────────────────

const MODE_ICON: Record<AccessMode, string> = { prompt: "🔐", deny: "🔒", allow: "🔓" };

function updateStatus(ctx: ExtensionContext) {
	const state = getState();
	if (!state.alive) return;
	const icon = MODE_ICON[state.mode];
	// Only color the mode word after the colon; the icon + label stay default.
	const modeWord =
		state.mode === "deny"
			? ctx.ui.theme.fg("error", state.mode)
			: state.mode === "allow"
				? ctx.ui.theme.fg("success", state.mode)
				: state.mode;
	ctx.ui.setStatus(STATUS_KEY, `${icon} access:${modeWord}`);
}

function formatPaths(paths: string[]): string {
	return paths.map((p) => `  • ${p}`).join("\n");
}

/** Prompt the user for an authorization decision. Returns undefined if dismissed. */
async function promptDecision(
	toolName: string,
	violations: string[],
	ctx: ExtensionContext,
): Promise<Decision | undefined> {
	const header = toolName === "bash" ? "bash command" : `${toolName}`;
	const body = `${header} wants to reach outside the project allowlist:\n\n${formatPaths(violations)}`;
	const choice = await ctx.ui.select(body, [
		"Accept (this once)",
		"Always accept (remember path this session)",
		"Deny",
		"Always deny (remember path this session)",
	]);
	switch (choice) {
		case "Accept (this once)":
			return "allow-once";
		case "Always accept (remember path this session)":
			return "allow-always";
		case "Deny":
			return "deny-once";
		case "Always deny (remember path this session)":
			return "deny-always";
		default:
			return undefined; // dismissed
	}
}

/** Ask for a deny reason. Optional — empty/Enter/dismiss falls back to a default. */
async function askReason(ctx: ExtensionContext): Promise<string> {
	const r = await ctx.ui.input("Reason for denying (optional)", "Why deny? Leave empty for default");
	return r && r.trim() ? r.trim() : "Denied by access-denied";
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const state = getState();
		state.config = loadConfig(ctx.cwd);
		state.mode = state.config.mode; // reset to configured mode each session
		state.alwaysAllow = new Set();
		state.alwaysDeny = new Map();
		state.alive = true;
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		const state = getState();
		state.alive = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		const state = getState();
		if (!state.alive) return; // not bound to a session yet

		const toolName = event.toolName;
		if (!state.config.tools.includes(toolName)) return;

		// Extract the out-of-bounds targets this call wants to reach.
		const cwd = ctx.cwd;
		const allowlist = buildAllowlist(cwd, state.config.extraAllowedDirs);
		let violations: string[];

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const target = resolveTarget(event.input.path, cwd);
			if (isSafe(target, state.config)) return; // always-safe, passthrough
			violations = isOutsideAllowlist(target, allowlist) ? [target] : [];
		} else if (isToolCallEventType("bash", event)) {
			violations = extractBashViolations(event.input.command, cwd, allowlist, state.config);
		} else {
			return; // tool not understood here — nothing to gate
		}

		if (violations.length === 0) return; // in-bounds, passthrough
		if (state.mode === "allow") return; // gate disabled

		// Cached session decisions short-circuit the prompt.
		if (state.alwaysDeny.size) {
			const hit = violations.find((v) => state.alwaysDeny.has(v));
			if (hit) {
				return { block: true, reason: `Always denied (${state.alwaysDeny.get(hit)})` };
			}
		}
		if (violations.every((v) => state.alwaysAllow.has(v))) return; // all whitelisted

		// deny mode blocks without asking.
		if (state.mode === "deny") {
			return { block: true, reason: `Blocked by access-denied (deny mode): ${formatPaths(violations)}` };
		}

		// prompt mode — but no UI available (print/json mode): fail safe.
		if (!ctx.hasUI) {
			return { block: true, reason: `Blocked (no UI to authorize): ${formatPaths(violations)}` };
		}

		const decision = await promptDecision(toolName, violations, ctx);
		switch (decision) {
			case "allow-once":
				return; // passthrough this one call
			case "allow-always":
				for (const v of violations) state.alwaysAllow.add(v);
				return;
			case "deny-once":
				return { block: true, reason: await askReason(ctx) };
			case "deny-always": {
				const reason = await askReason(ctx);
				for (const v of violations) state.alwaysDeny.set(v, reason);
				return { block: true, reason };
			}
			default:
				// dismissed — treat as a soft deny so the agent learns it was not authorized
				return { block: true, reason: "Authorization dismissed" };
		}
	});

	// ── Command: /access-denied [prompt|deny|allow|status|reset] ──────────

	pi.registerCommand("access-denied", {
		description: "View or change access-denied mode: prompt | deny | allow | status | reset",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const opts = ["prompt", "deny", "allow", "status", "reset"];
			const items = opts.map((o) => ({ value: o, label: o }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const state = getState();
			const arg = (args || "").trim().toLowerCase();

			if (arg === "prompt" || arg === "deny" || arg === "allow") {
				state.mode = arg;
				ctx.ui.notify(`access-denied → ${arg}`, "info");
				updateStatus(ctx);
				return;
			}

			if (arg === "reset") {
				state.alwaysAllow.clear();
				state.alwaysDeny.clear();
				ctx.ui.notify("Cleared session allow/deny memory", "info");
				return;
			}

			// status (default)
			const allow = [...state.alwaysAllow].sort();
			const deny = [...state.alwaysDeny.entries()].sort();
			const allowlist = buildAllowlist(ctx.cwd, state.config.extraAllowedDirs);
			const safeLines: string[] = [
				"/dev/null, /dev/std{in,out,err}, /dev/zero, /dev/{u,}random, /dev/fd/",
			];
			if (state.config.allowTempDir) safeLines.push(`temp: ${os.tmpdir()}`);
			for (const p of state.config.extraSafePaths) safeLines.push(p);
			const lines = [
				`Mode: ${state.mode}   Tools: ${state.config.tools.join(", ")}`,
				`Allowlist (full read/write roots):`,
				...allowlist.map((d) => `  • ${d}`),
				`Always-safe (no prompt):`,
				...safeLines.map((d) => `  • ${d}`),
				`Always-allow (${allow.length}):`,
				...(allow.length ? allow.map((p) => `  • ${p}`) : ["  (none)"]),
				`Always-deny (${deny.length}):`,
				...(deny.length ? deny.map(([p, r]) => `  • ${p}  — ${r}`) : ["  (none)"]),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
