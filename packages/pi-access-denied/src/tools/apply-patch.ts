import { paths } from "../paths.ts";
import type { ExtractedTarget, ToolAdapter } from "./types.ts";

// Codex patch markers trim Unicode White_Space; a BOM remains literal path text.
const trimEnd = (text: string): string => text.replace(/\p{White_Space}+$/u, "");
const trim = (text: string): string => trimEnd(text.replace(/^\p{White_Space}+/u, ""));

/** Extract declared paths without validating hunks or inspecting the filesystem. @internal */
export function extractPatchTargets(input: string, cwd: string): ExtractedTarget[] {
  const targets: ExtractedTarget[] = [];
  const seen = new Set<string>();
  let inUpdate = false;
  for (const raw of trim(input).split(/\r?\n/)) {
    // Leading spaces inside an Update are context prefixes, not header padding.
    const marker = inUpdate ? trimEnd(raw) : trim(raw);
    if (marker === "*** End Patch") break;
    const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(marker);
    if (!header) continue;
    if (header[1] !== "Move to") inUpdate = header[1] === "Update File";
    const path = paths.resolve(cwd, header[2]);
    const key = paths.key(path);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ path, source: marker });
  }
  return targets;
}

export const applyPatchAdapter: ToolAdapter = {
  extract(input, cwd) {
    return typeof input.input === "string" ? extractPatchTargets(input.input, cwd) : [];
  },
};
