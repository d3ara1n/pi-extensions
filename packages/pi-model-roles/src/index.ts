/**
 * pi-model-roles — Extension entry point.
 *
 * Pure dependency library: no tools, no commands.
 * Initializes the ModelRolesAPI singleton on session_start,
 * tracks current model via model_select.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initModelRolesAPI, updateCurrentModel } from "./api.ts";

export { getModelRolesAPI } from "./api.ts";
export type { ModelRolesAPI, RoleConfig, ResolvedRole, ModelRolesConfig, ThinkingLevel } from "./types.ts";

export default function registerModelRolesExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		initModelRolesAPI(ctx.settings, ctx.modelRegistry, ctx.model);
	});

	pi.on("model_select", async (event) => {
		updateCurrentModel(event.model);
	});
}
