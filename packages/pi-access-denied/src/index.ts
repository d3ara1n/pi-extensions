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
import {
	buildAllowlist,
	coveringRoot,
	extractBashViolations,
	isCoveredBy,
	isOutsideAllowlist,
	isSafe,
	rememberAllowed,
	rememberDenied,
	resolveTarget,
} from "./paths.ts";
import { DEFAULT_CONFIG, type AccessMode, type AuthResult } from "./types.ts";
import { AuthPanel } from "./auth-panel.ts";

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

// Nerd Font: nf-fa-key / nf-fa-lock / nf-fa-unlock
const MODE_ICON: Record<AccessMode, string> = { prompt: "\uf084", deny: "\uf023", allow: "\uf13c" };

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

/**
 * Show the authorization panel. Returns an {@link AuthResult}; when the user
 * dismisses the path list (Esc), `cancelled` is true.
 */
async function promptDecision(
	toolName: string,
	violations: string[],
	ctx: ExtensionContext,
): Promise<AuthResult> {
	const header = toolName === "bash" ? "bash command" : `${toolName}`;
	return ctx.ui.custom<AuthResult>((tui, theme, _kb, done) => {
		return new AuthPanel(violations, header, tui, theme, { onResult: (r) => done(r) });
	}, {
		// overlay:false renders the panel into pi's bottom editorContainer slot
		// (the same path ctx.ui.select()/input() take) instead of compositing a
		// screen overlay over everything. The chat transcript stays visible above
		// the panel and is scrollable via the terminal's native scrollback.
		// overlay:true would hide the transcript via ui.showOverlay(), making it
		// unscrollable — see pi-ask-user for the same design decision.
		overlay: false,
	});
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
			if (isSafe(target, { extraSafePaths: state.config.extraSafePaths })) return; // always-safe
			violations = isOutsideAllowlist(target, allowlist) ? [target] : [];
		} else if (isToolCallEventType("bash", event)) {
			violations = extractBashViolations(event.input.command, cwd, allowlist, {
				extraSafePaths: state.config.extraSafePaths,
			});
		} else {
			return; // tool not understood here — nothing to gate
		}

		if (violations.length === 0) return; // in-bounds, passthrough
		if (state.mode === "allow") return; // gate disabled

		// Cached session decisions short-circuit the prompt. Both memories use
		// prefix coverage: remembering a parent covers its whole subtree.
		if (state.alwaysDeny.size) {
			for (const v of violations) {
				const root = coveringRoot(v, state.alwaysDeny.keys());
				if (root) {
					// `alwaysDeny` stores the user's raw note (possibly empty); wrap it
					// the same way as a fresh deny so a misleading note can't pass as
					// an operation result. See the deny branch below for the rationale.
					const note = state.alwaysDeny.get(root);
					return {
						block: true,
						reason: note
							? `Blocked by access-denied, always denied (user note: "${note}")`
							: "Blocked by access-denied (always denied)",
					};
				}
			}
		}
		if (violations.every((v) => isCoveredBy(v, state.alwaysAllow))) return; // all whitelisted

		// deny mode blocks without asking.
		if (state.mode === "deny") {
			return { block: true, reason: `Blocked by access-denied (deny mode): ${formatPaths(violations)}` };
		}

		// prompt mode — but no UI available (print/json mode): fail safe.
		if (!ctx.hasUI) {
			return { block: true, reason: `Blocked (no UI to authorize): ${formatPaths(violations)}` };
		}

		const result = await promptDecision(toolName, violations, ctx);
		if (result.cancelled) {
			// dismissed — soft deny so the agent learns it was not authorized
			return { block: true, reason: "Authorization dismissed" };
		}

		// Any deny → block the whole call. Deny-always paths are remembered
		// individually; the stored value is the user's raw note (the panel's
		// single global reason), NOT the wrapped string — so `/access-denied
		// status` shows it verbatim and the cache-hit branch re-wraps it.
		const hasDeny = [...result.choices.values()].some((c) => c === "deny" || c === "always-deny");
		if (hasDeny) {
			// The user's reason is free-form, untrusted text. Hand it to the LLM
			// as a quoted "user note" so it can't masquerade as the operation's
			// outcome — e.g. a note like "file written successfully" must never
			// read as "the write succeeded". `is_error: true` (set by the
			// framework) is the primary signal; this wrapping is defense-in-depth
			// for when a model or gateway de-emphasizes that flag.
			const userNote = result.reason?.trim();
			const reason = userNote
				? `Blocked by access-denied (user note: "${userNote}")`
				: "Blocked by access-denied";
			for (const [p, c] of result.choices) {
				if (c === "always-deny") rememberDenied(state.alwaysDeny, p, userNote ?? "");
			}
			return { block: true, reason };
		}

		// All accept / always-accept → passthrough; always-accept paths remembered.
		for (const [p, c] of result.choices) {
			if (c === "always-accept") rememberAllowed(state.alwaysAllow, p);
		}
		return; // passthrough this one call
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
				"/tmp, " + os.tmpdir(),
			];
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
				// `r` is the user's raw note and may be empty (deny with no reason);
				// omit the trailing dash in that case so the status line is clean.
				...(deny.length ? deny.map(([p, r]) => (r ? `  • ${p}  — ${r}` : `  • ${p}`)) : ["  (none)"]),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
