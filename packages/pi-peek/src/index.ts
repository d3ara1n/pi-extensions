/**
 * pi-peek — Extension entry point.
 *
 * Dependency library: exposes PeekAPI singleton (serialize + investigate +
 * tracker). Registers hooks to track the main agent, but registers NO
 * tools/commands and NO cross-instance machinery — installing pi-peek alone
 * does nothing observable. It only provides capability for consumers:
 *
 *   - pi-peek-user  → /peek overlay asks THIS instance (local consult)
 *   - pi-peek-agent → cross-instance peek tool + UDS mesh + discovery
 *
 * Cross-instance transport (UDS) and peer discovery are pi-peek-agent's job.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initPeekAPI } from "./api.ts";
import * as tracker from "./tracker.ts";
import { loadPeekConfig } from "./config.ts";

export { getPeekAPI } from "./api.ts";
export type {
	PeekAPI,
	MainAgentStatus,
	InvestigateOptions,
	InvestigateResult,
	PeekConfig,
} from "./types.ts";

export default function registerPeekExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		initPeekAPI({
			sessionManager: ctx.sessionManager,
			config: loadPeekConfig(ctx.cwd),
		});
	});

	// ── tracker hooks (fire every turn; feed the status snapshot) ─────────
	pi.on("turn_start", (event) => tracker.onTurnStart(event.turnIndex));
	pi.on("turn_end", (event) => tracker.onTurnEnd(event.turnIndex));
	pi.on("tool_execution_start", (event) => tracker.onToolStart(event.toolName, event.args));
	pi.on("tool_execution_end", (event) => tracker.onToolEnd(event.toolName));

}
