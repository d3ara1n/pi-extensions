/**
 * Model-router module — decides whether to switch model roles.
 *
 * Self-describing: owns its prompt fragments, parsing, validation (rejects
 * unknown / hidden roles), status rendering, and the role-switch side effect.
 */

import type { ScoutModule, ApplyResult } from "../types.ts";
import { switchToRole } from "../model-switch.ts";

/**
 * Parse the role field: "null" / "none" / "current" / "keep" → null.
 * @internal — exported for testing.
 */
export function parseRole(raw: string): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (lower === "null" || lower === "none" || lower === "current" || lower === "keep") {
    return null;
  }
  return raw.trim() || null;
}

export const modelRouterModule: ScoutModule<string | null> = {
  key: "modelRouter",
  field: "role",
  noun: "model role",
  label: "model-router",
  sectionTitle: "Available Roles",
  responseRule: '- role: role name from the available list, or "null" to keep current',

  formatLine: () => "role: role-name-or-null",

  rules: () => [
    `- "role" should be null if the current role is appropriate.`,
    "- Only suggest a role change when the task clearly benefits from a different model.",
  ],

  candidates: (ctx) => {
    const visible = ctx.rolesApi.getVisibleRoles();
    return Object.entries(visible)
      .map(
        ([name, cfg]: [string, any]) =>
          `- ${name}: ${cfg.description ?? "(no description)"}${
            cfg.model ? ` (model: ${cfg.model})` : " (current model)"
          }`,
      )
      .join("\n");
  },

  promptContextLine: (ctx) => `Current role: ${ctx.currentRole}`,

  parse: (raw) => parseRole(raw),

  validate: (value, ctx) => {
    if (value == null) return { value: null };
    const visible = ctx.rolesApi.getVisibleRoles();
    if (!visible[value]) {
      return { value: null, error: "side agent selected an unknown or hidden role" };
    }
    return { value };
  },

  disabledValue: () => null,

  formatStatus: (value, ctx) =>
    value ? ctx.theme.fg("dim", "→ ") + ctx.theme.fg("warning", value) : null,

  describe: (value) => value ?? "(no change)",

  apply: async (value, ctx): Promise<ApplyResult | void> => {
    // No-op when keeping the current role.
    if (value == null || value === ctx.currentRole) return;

    const switched = await switchToRole(ctx.pi, value, ctx.rolesApi);
    if (!switched.ok) {
      return { error: switched.reason ?? "model switch failed" };
    }

    const resolved = await ctx.rolesApi.resolveRoleAsync(value);
    if (resolved?.model) {
      return {
        systemPrompt:
          ctx.systemPrompt +
          `\n\n<current_model>${resolved.model.provider}/${resolved.model.id} (role: ${value})</current_model>`,
      };
    }
  },
};
