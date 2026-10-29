import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, type PatchConfig } from "./config.ts";
import { makeApplyPatchTool } from "./tool.ts";

export default function applyPatchExtension(pi: ExtensionAPI): void {
  // Patch config is read once per session; a project `applyPatch` block
  // replaces the global one. Edits to settings.json take effect after /reload
  // or a restart, like every other extension setting.
  let config: PatchConfig = DEFAULT_CONFIG;
  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(ctx.cwd);
  });

  pi.registerTool(makeApplyPatchTool(undefined, () => config));
}
