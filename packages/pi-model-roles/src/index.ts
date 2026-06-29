/**
 * pi-model-roles — Extension entry point.
 *
 * Dependency library: provides ModelRolesAPI singleton.
 * Registers /roles command for inspection.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initModelRolesAPI, getModelRolesAPI, updateCurrentModel } from "./api.ts";

export { getModelRolesAPI } from "./api.ts";
export type {
  ModelRolesAPI,
  RoleConfig,
  ResolvedRole,
  ModelRolesConfig,
  ThinkingLevel,
} from "./types.ts";

export default function registerModelRolesExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    initModelRolesAPI(ctx.modelRegistry, ctx.model, ctx.cwd);
  });

  pi.on("model_select", async (event) => {
    updateCurrentModel(event.model);
  });

  pi.registerCommand("roles", {
    description: "Show model role definitions and resolved models",
    handler: async (_args, ctx) => {
      const api = getModelRolesAPI();
      const roles = api.getRoles();
      const lines: string[] = ["Model Roles:", ""];

      for (const [name, config] of Object.entries(roles)) {
        const resolved = api.resolveRole(name);
        const hidden = config.hidden ? " (hidden)" : "";
        const modelLabel = resolved.model
          ? `${resolved.model.provider}/${resolved.model.id}`
          : config.model === null
            ? "→ current model"
            : `→ NOT FOUND (${config.model})`;
        const thinking = config.thinking ? ` thinking:${config.thinking}` : "";
        lines.push(`  ${name}: ${modelLabel}${thinking}${hidden}`);
      }

      lines.push("");
      lines.push(`Default role: ${api.getDefaultRole()}`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
