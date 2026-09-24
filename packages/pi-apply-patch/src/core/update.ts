// Adapted from openai/codex apply-patch at b04a2c2645. See NOTICE.
import { countOccurrences, diagnoseContext } from "./diagnostics.ts";
import { seekPass, seekSequence, strategyOf } from "./matcher.ts";
import { splitSource } from "./source.ts";
import type { Chunk, HunkOutcome } from "./types.ts";

/** seekSequence found a match, so pass 0 is the safe fallback if seekPass ever disagrees. */
const EXACT_PASS = 0;

interface Replacement {
  index: number;
  count: number;
  lines: readonly string[];
  sources?: readonly (number | null)[];
}

export interface UpdatePlan {
  readonly replacements: readonly Replacement[];
  /** Every chunk's match outcome; unmatched chunks do not stop later chunks from being searched. */
  readonly outcomes: readonly HunkOutcome[];
}

/** Match logical lines while retaining a leading BOM for position-aware comparison. */
function sourceLines(original: string): string[] {
  const source = splitSource(original);
  const lines = source.lines.map((line) => line.text);
  if (source.bom && lines.length) lines[0] = source.bom + lines[0];
  return lines;
}

/**
 * Match every chunk against the source, collecting all failures instead of
 * stopping at the first. The replacements of a fully matched plan are exactly
 * what {@link applyUpdate} applies.
 */
export function planUpdate(original: string, chunks: readonly Chunk[]): UpdatePlan {
  const lines = sourceLines(original);
  const replacements: Replacement[] = [];
  const outcomes: HunkOutcome[] = [];
  let cursor = 0;
  for (const [position, chunk] of chunks.entries()) {
    const hunk = position + 1;
    if (chunk.anchor !== undefined) {
      const anchor = seekSequence(lines, [chunk.anchor], cursor);
      if (anchor === undefined) {
        outcomes.push({
          hunk,
          status: "unmatched",
          failure: diagnoseContext(lines, {
            anchor: chunk.anchor,
            pattern: [chunk.anchor],
            replacement: [],
            start: cursor,
            endOfFile: chunk.endOfFile,
          }),
        });
        continue;
      }
      cursor = anchor + 1;
    }
    if (!chunk.oldLines.length) {
      const index = lines.at(-1) === "" ? lines.length - 1 : lines.length;
      replacements.push({ index, count: 0, lines: chunk.newLines, sources: chunk.newLineSources });
      outcomes.push({ hunk, status: "matched", line: index + 1, strategy: "exact", occurrences: 1 });
      continue;
    }
    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let sources = chunk.newLineSources;
    let index = seekSequence(lines, pattern, cursor, chunk.endOfFile);
    if (index === undefined && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (replacement.at(-1) === "") {
        replacement = replacement.slice(0, -1);
        sources = sources?.slice(0, -1);
      }
      index = seekSequence(lines, pattern, cursor, chunk.endOfFile);
    }
    if (index === undefined) {
      outcomes.push({
        hunk,
        status: "unmatched",
        failure: diagnoseContext(lines, {
          pattern,
          replacement,
          start: cursor,
          endOfFile: chunk.endOfFile,
        }),
      });
      continue;
    }
    replacements.push({ index, count: pattern.length, lines: replacement, sources });
    const pass = seekPass(lines, pattern, index) ?? EXACT_PASS;
    outcomes.push({
      hunk,
      status: "matched",
      line: index + 1,
      strategy: strategyOf(pass),
      occurrences: countOccurrences(lines, pattern, pass),
    });
    cursor = index + pattern.length;
  }
  return { replacements, outcomes };
}

/** Preserve source context and line endings while applying explicit additions and removals. */
export function applyReplacements(
  original: string,
  replacements: readonly Replacement[],
): string {
  const source = splitSource(original);
  let result = [...source.lines];
  for (const replacement of [...replacements].sort((a, b) => a.index - b.index).reverse()) {
    const added: typeof source.lines = [];
    let oldCursor = 0;
    for (let offset = 0; offset < replacement.lines.length;) {
      const oldOffset = replacement.sources?.[offset];
      const context = oldOffset == null ? undefined : source.lines[replacement.index + oldOffset];
      if (context) {
        added.push(context);
        oldCursor = oldOffset! + 1;
        offset++;
        continue;
      }
      let end = offset + 1;
      while (end < replacement.lines.length && replacement.sources?.[end] == null) end++;
      const nextOld = replacement.sources?.[end] ?? replacement.count;
      const removed = Math.max(0, nextOld - oldCursor);
      const nearbyEnding =
        source.lines[replacement.index + oldCursor - 1]?.ending ||
        source.lines[replacement.index + oldCursor]?.ending ||
        source.defaultEnding;
      for (let index = offset; index < end; index++) {
        let text = replacement.lines[index];
        const oldLine = removed
          ? source.lines[replacement.index + oldCursor + Math.min(index - offset, removed - 1)]
          : undefined;
        const ending = oldLine?.ending || nearbyEnding;
        // A BOM copied from the first source line must not duplicate metadata.
        if (source.bom && replacement.index === 0 && index === 0 && text.startsWith("\uFEFF"))
          text = text.slice(1);
        added.push({ text, ending });
      }
      oldCursor = nextOld;
      offset = end;
    }
    // Avoid spreading large additions into splice's argument list.
    result = result
      .slice(0, replacement.index)
      .concat(added, result.slice(replacement.index + replacement.count));
  }
  return source.bom + result.map((line) => line.text + (line.ending || source.defaultEnding)).join("");
}

/** Apply chunks with BOM, original context, and line-ending preservation. @internal */
export function applyUpdate(original: string, chunks: readonly Chunk[], path: string): string {
  const plan = planUpdate(original, chunks);
  const failure = plan.outcomes.find(
    (outcome): outcome is Extract<HunkOutcome, { status: "unmatched" }> =>
      outcome.status === "unmatched",
  );
  if (failure) {
    if (failure.failure.anchor !== undefined)
      throw new Error(`Failed to find context '${failure.failure.anchor}' in ${path}`);
    throw new Error(`Failed to find expected lines in ${path}:\n${failure.failure.pattern.join("\n")}`);
  }
  return applyReplacements(original, plan.replacements);
}
