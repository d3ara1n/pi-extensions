// Adapted from openai/codex apply-patch at b04a2c2645. See NOTICE.
import { seekSequence } from "./matcher.ts";
import type { Chunk } from "./types.ts";

type Replacement = { index: number; count: number; lines: readonly string[] };

/** Apply chunks using the pinned upstream default line-ending behavior. @internal */
export function applyUpdate(original: string, chunks: readonly Chunk[], path: string): string {
  const lines = original.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements: Replacement[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== undefined) {
      const anchor = seekSequence(lines, [chunk.anchor], cursor);
      if (anchor === undefined)
        throw new Error(`Failed to find context '${chunk.anchor}' in ${path}`);
      cursor = anchor + 1;
    }
    if (!chunk.oldLines.length) {
      replacements.push({
        index: lines.at(-1) === "" ? lines.length - 1 : lines.length,
        count: 0,
        lines: chunk.newLines,
      });
      continue;
    }
    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let index = seekSequence(lines, pattern, cursor, chunk.endOfFile);
    if (index === undefined && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (replacement.at(-1) === "") replacement = replacement.slice(0, -1);
      index = seekSequence(lines, pattern, cursor, chunk.endOfFile);
    }
    if (index === undefined)
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    replacements.push({ index, count: pattern.length, lines: replacement });
    cursor = index + pattern.length;
  }
  replacements.sort((a, b) => a.index - b.index);
  let result = lines;
  for (const replacement of replacements.reverse()) {
    // Avoid spreading large additions into splice's argument list.
    result = result
      .slice(0, replacement.index)
      .concat(replacement.lines, result.slice(replacement.index + replacement.count));
  }
  if (result.at(-1) !== "") result.push("");
  return result.join("\n");
}
