/**
 * Read role configuration from pi settings.
 *
 * Merge strategy: built-in defaults form the base, user settings override per-role.
 * Only roles present in user config are overridden; unmentioned roles keep defaults.
 * User can also add entirely new roles not in the built-in set.
 */

import type { ModelRolesConfig, RoleConfig } from "./types.ts";
import { BUILTIN_DEFAULT_ROLES } from "./defaults.ts";

const DEFAULT_ROLE_NAME = "default";

/**
 * Load modelRoles config from pi settings, merged with built-in defaults.
 */
export function loadRolesConfig(settings: any): ModelRolesConfig {
	// Start from built-in defaults
	const mergedRoles: Record<string, RoleConfig> = {};

	for (const [name, config] of Object.entries(BUILTIN_DEFAULT_ROLES)) {
		mergedRoles[name] = { ...config };
	}

	// User config overrides and adds new roles
	const userConfig = settings?.modelRoles;
	if (userConfig?.roles && typeof userConfig.roles === "object") {
		for (const [name, config] of Object.entries(userConfig.roles as Record<string, Partial<RoleConfig>>)) {
			if (mergedRoles[name]) {
				// Override: user fields win over defaults
				mergedRoles[name] = { ...mergedRoles[name], ...config };
			} else {
				// New user-defined role
				mergedRoles[name] = config as RoleConfig;
			}
		}
	}

	return {
		roles: mergedRoles,
		defaultRole: userConfig?.defaultRole ?? DEFAULT_ROLE_NAME,
	};
}
