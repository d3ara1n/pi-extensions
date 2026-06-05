/**
 * Model role switching logic.
 *
 * Caller only needs to check resolved.model — it's always a real model or undefined.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";

/**
 * Switch the active model to the given role.
 * @returns true if the switch was successful
 */
export async function switchToRole(
	pi: ExtensionAPI,
	roleName: string,
	rolesApi: ModelRolesAPI,
): Promise<boolean> {
	const resolved = await rolesApi.resolveRoleAsync(roleName);

	if (!resolved.model) {
		console.warn(`[pi-scout] Role "${roleName}" could not be resolved — model not available`);
		return false;
	}

	const success = await pi.setModel(resolved.model);
	if (!success) {
		console.warn(`[pi-scout] setModel() returned false for role "${roleName}" — no API key?`);
		return false;
	}

	if (resolved.config.thinking) {
		pi.setThinkingLevel(resolved.config.thinking);
	}

	return true;
}
