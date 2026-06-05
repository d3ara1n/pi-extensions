/**
 * Read scout configuration from pi settings.
 */

import type { ScoutConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

/**
 * Load scout config from pi settings.
 * Falls back to defaults for missing fields.
 */
export function loadScoutConfig(settings: any): ScoutConfig {
	if (!settings?.scout) return DEFAULT_CONFIG;

	const raw = settings.scout;
	return {
		enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
		sideAgentRole: raw.sideAgentRole ?? DEFAULT_CONFIG.sideAgentRole,
		maxSelectedSkills: raw.maxSelectedSkills ?? DEFAULT_CONFIG.maxSelectedSkills,
		modules: {
			skillRouter: raw.modules?.skillRouter ?? DEFAULT_CONFIG.modules.skillRouter,
			modelRouter: raw.modules?.modelRouter ?? DEFAULT_CONFIG.modules.modelRouter,
		},
	};
}
