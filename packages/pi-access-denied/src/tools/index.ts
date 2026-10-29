import { applyPatchAdapter } from "./apply-patch.ts";
import { bashAdapter } from "./bash.ts";
import { fileAdapter } from "./file.ts";
import type { ToolAdapter } from "./types.ts";

/** Register tool input formats here; defaults and configuration validation use the same table. */
export const TOOL_ADAPTERS = {
  write: fileAdapter,
  edit: fileAdapter,
  bash: bashAdapter,
  apply_patch: applyPatchAdapter,
} satisfies Record<string, ToolAdapter>;

export type SupportedTool = keyof typeof TOOL_ADAPTERS;
export const SUPPORTED_TOOLS = Object.keys(TOOL_ADAPTERS) as SupportedTool[];

export function isSupportedTool(name: string): name is SupportedTool {
  return Object.hasOwn(TOOL_ADAPTERS, name);
}
