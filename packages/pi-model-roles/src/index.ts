/**
 * pi-model-roles — Extension entry point.
 *
 * Extension dependency library: provides a ModelRolesAPI singleton and a
 * /roles inspection command. It registers session/model hooks to initialize
 * and keep the singleton current.
 */

import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { initModelRolesAPI, getModelRolesAPI, updateCurrentModel } from "./api.ts";

/** How many model IDs to show in the collapsed tool result before truncating. */
const COLLAPSED_PREVIEW = 3;

interface ListModelsDetails {
  models: string[];
}

export { getModelRolesAPI } from "./api.ts";
export type {
  ModelRolesAPI,
  RoleConfig,
  ResolvedRole,
  ModelRolesConfig,
  ThinkingLevel,
} from "./types.ts";
// Re-export pi-ai types so consumers depend on model-roles alone, not pi-ai.
export type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export default function registerModelRolesExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    initModelRolesAPI(ctx.modelRegistry, ctx.model, ctx.cwd);
  });

  pi.on("model_select", async (event) => {
    updateCurrentModel(event.model);
  });

  pi.registerTool({
    name: "list_models",
    label: "List available models",
    description: "List all available models from pi's model registry. Returns provider/model-id strings (e.g. 'anthropic/claude-sonnet-4'). Useful for confirming model IDs before referencing a model by name.",
    parameters: Type.Object({}),
    async execute() {
      const api = getModelRolesAPI();
      const models = api.listModels();
      return {
        // Full list sent to the LLM — UI truncation is purely cosmetic.
        content: [{ type: "text", text: models.join("\n") }],
        details: { models } satisfies ListModelsDetails,
      };
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as ListModelsDetails | undefined;
      const models = details?.models ?? [];
      const count = models.length;

      const shown = expanded ? models : models.slice(0, COLLAPSED_PREVIEW);
      const omitted = count - shown.length;

      let text = theme.fg("success", `${count} models`);
      for (const m of shown) {
        text += `\n  ${theme.fg("dim", m)}`;
      }
      if (omitted > 0) {
        text += `\n  ${theme.fg("muted", `… +${omitted} more (${keyHint("app.tools.expand", "expand")})`)}`;
      }
      return new Text(text, 0, 0);
    },
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
