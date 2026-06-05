/**
 * Read subagent configuration from pi settings.
 */

import type { SubagentConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

export function loadSubagentConfig(settings: any): SubagentConfig {
	if (!settings?.subagent) return DEFAULT_CONFIG;

	const raw = settings.subagent;
	return {
		timeoutMs: raw.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
	};
}
