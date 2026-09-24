import type { HunkLineDifference } from "./core/types.ts";

const INVISIBLE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{M}]/u;
const NAMES: Readonly<Record<number, string>> = {
  0x09: "TAB", 0x0a: "LINE FEED", 0x0d: "CARRIAGE RETURN", 0x20: "SPACE",
  0xa0: "NO-BREAK SPACE", 0x200b: "ZERO WIDTH SPACE", 0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER", 0x2060: "WORD JOINER", 0xfeff: "BOM / ZERO WIDTH NO-BREAK SPACE",
};

function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

function escapedChar(char: string): string {
  if (INVISIBLE.test(char)) {
    const value = char.codePointAt(0)!;
    return value <= 0xffff
      ? `\\u${value.toString(16).toUpperCase().padStart(4, "0")}`
      : `\\u{${value.toString(16).toUpperCase()}}`;
  }
  return JSON.stringify(char).slice(1, -1);
}

/** Bounded, visibly escaped text for model-facing errors. @internal */
export function visibleText(text: string, focus = 0): string {
  const chars = Array.from(text);
  const start = Math.max(0, focus - 35);
  const end = Math.min(chars.length, Math.max(start + 80, focus + 1));
  const excerpt = chars.slice(start, end).map(escapedChar).join("");
  const range = start || end < chars.length ? ` (excerpt, columns ${start + 1}-${end})` : "";
  return `"${excerpt}"${range}`;
}

function describe(char: string | undefined): string {
  if (char === undefined) return "end of line";
  const value = char.codePointAt(0)!;
  return `${NAMES[value] ?? (INVISIBLE.test(char) ? "INVISIBLE / COMBINING CHARACTER" : visibleText(char))} (${codePoint(char)})`;
}

function runAt(chars: readonly string[], position: number): string {
  if (!chars[position] || !INVISIBLE.test(chars[position])) position--;
  const char = chars[position];
  if (!char || !INVISIBLE.test(char)) return "none";
  let start = position;
  let end = position + 1;
  while (start > 0 && chars[start - 1] === char) start--;
  while (end < chars.length && chars[end] === char) end++;
  return `${describe(char)} × ${end - start} at column ${start + 1}`;
}

/** Explain one aligned difference using Unicode code-point columns. @internal */
export function describeDifference(detail: HunkLineDifference): string[] {
  if (detail.expected === undefined)
    return [`extra source line ${detail.actualLine}: ${visibleText(detail.actual!)}`];
  if (detail.actual === undefined)
    return [`missing source line for context line ${detail.expectedLine}: ${visibleText(detail.expected)}`];
  const expected = Array.from(detail.expected);
  const actual = Array.from(detail.actual);
  let offset = 0;
  while (offset < expected.length && offset < actual.length && expected[offset] === actual[offset]) offset++;
  const rows = [
    `context line ${detail.expectedLine}, source line ${detail.actualLine}:`,
    `expected: ${visibleText(detail.expected, offset)}`,
    `actual:   ${visibleText(detail.actual, offset)}`,
    `first difference at column ${offset + 1} (Unicode code points): expected ${describe(expected[offset])}; actual ${describe(actual[offset])}`,
  ];
  const expectedRun = runAt(expected, offset);
  const actualRun = runAt(actual, offset);
  if (expectedRun !== "none" || actualRun !== "none")
    rows.push(`adjacent invisible run: expected ${expectedRun}; actual ${actualRun}`);
  return rows;
}
