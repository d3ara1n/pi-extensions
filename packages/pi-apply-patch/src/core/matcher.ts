// Adapted from openai/codex apply-patch at b04a2c2645. See NOTICE.
import { trim, trimEnd } from "./text.ts";

function normalize(text: string): string {
  return trim(text)
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

/** Search in Codex's default NormalizeToLf mode. @internal */
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
  for (const project of [(text: string) => text, trimEnd, trim, normalize]) {
    const expected = pattern.map(project);
    for (let index = first; index <= end; index++) {
      if (expected.every((line, offset) => project(lines[index + offset]) === line)) return index;
    }
  }
  return undefined;
}
