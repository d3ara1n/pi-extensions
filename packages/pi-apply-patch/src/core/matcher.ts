// Adapted from openai/codex apply-patch at b04a2c2645. See NOTICE.
import type { MatchStrategy } from "./types.ts";
import { trim, trimEnd } from "./text.ts";

/** @internal — Unicode punctuation and space folding used by the loosest pass. */
export function normalize(text: string): string {
  return trim(text)
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

/** Comparison passes in Codex's fixed precision order, tightest first. @internal */
export const PASSES: readonly ((text: string) => string)[] = [
  (text) => text,
  trimEnd,
  trim,
  normalize,
];

/** Remove BOM metadata only when comparing the first source line. @internal */
export function comparisonPair(
  actual: string,
  expected: string,
  sourceIndex: number,
): [actual: string, expected: string] {
  if (sourceIndex === 0 && actual.startsWith("\uFEFF")) {
    actual = actual.slice(1);
    if (expected.startsWith("\uFEFF")) expected = expected.slice(1);
  }
  return [actual, expected];
}

/** Compare logical source text using the same BOM policy as diagnostics. @internal */
export function equalLine(
  actual: string,
  expected: string,
  sourceIndex: number,
  project: (text: string) => string,
): boolean {
  if (sourceIndex === 0) [actual, expected] = comparisonPair(actual, expected, sourceIndex);
  return project(actual) === project(expected);
}

const STRATEGIES: readonly MatchStrategy[] = ["exact", "trim_end", "trim", "unicode"];

/** @internal Name of the comparison pass at `pass` (0-based, PASSES order). */
export function strategyOf(pass: number): MatchStrategy {
  return STRATEGIES[pass];
}

/** Lowest pass at which the pattern matches `lines` at `index`, or undefined. @internal */
export function seekPass(
  lines: readonly string[],
  pattern: readonly string[],
  index: number,
): number | undefined {
  if (pattern.length === 0 || index < 0 || index + pattern.length > lines.length) return undefined;
  for (let pass = 0; pass < PASSES.length; pass++) {
    const project = PASSES[pass];
    let equal = true;
    for (let offset = 0; offset < pattern.length; offset++) {
      if (!equalLine(lines[index + offset], pattern[offset], index + offset, project)) {
        equal = false;
        break;
      }
    }
    if (equal) return pass;
  }
  return undefined;
}

/** Search logical source lines in fixed precision order. @internal */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof = false,
): number | undefined {
  if (!pattern.length) return start;
  const end = lines.length - pattern.length;
  if (end < 0) return undefined;
  const first = eof ? end : start;
  // Complete each precision pass before attempting a looser match anywhere.
  for (const project of PASSES) {
    for (let index = first; index <= end; index++) {
      if (pattern.every((line, offset) => equalLine(lines[index + offset], line, index + offset, project)))
        return index;
    }
  }
  return undefined;
}
