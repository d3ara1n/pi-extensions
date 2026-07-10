/**
 * Model role switching logic.
 *
 * Caller only needs to check resolved.model — it's always a real model or undefined.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";

/** Result of a model-role switch attempt. */
export interface SwitchResult {
  ok: boolean;
  /** Failure reason when ok is false (shown in the status bar). */
  reason?: string;
}

/**
 * Switch the active model to the given role.
 * @returns SwitchResult — check `.ok`; on failure `.reason` explains why.
 */
export async function switchToRole(
  pi: ExtensionAPI,
  roleName: string,
  rolesApi: ModelRolesAPI,
): Promise<SwitchResult> {
  const resolved = await rolesApi.resolveRoleAsync(roleName);

  if (!resolved.model) {
    return { ok: false, reason: `role "${roleName}" model unavailable` };
  }

  const success = await pi.setModel(resolved.model);
  if (!success) {
    return { ok: false, reason: `no API key for role "${roleName}"` };
  }

  if (resolved.config.thinking) {
    pi.setThinkingLevel(resolved.config.thinking);
  }

  return { ok: true };
}
