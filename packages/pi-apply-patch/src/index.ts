import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeApplyPatchTool } from "./tool.ts";

export default function applyPatchExtension(pi: ExtensionAPI): void {
  pi.registerTool(makeApplyPatchTool());
}
