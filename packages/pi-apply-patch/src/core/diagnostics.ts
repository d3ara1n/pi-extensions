import { comparisonPair, equalLine, normalize, PASSES, seekSequence } from "./matcher.ts";
import { trim, trimEnd } from "./text.ts";
import type { HunkCandidate, HunkFailure, HunkLineDifference } from "./types.ts";

/** Skip candidate and occurrence scans when they would exceed this many line comparisons. */
const SCAN_BUDGET = 2_000_000;
const MIN_CANDIDATE_SCORE = 0.5;
const MAX_DIFFERENCES = 3;

/** Diagnostic-only comparison: trim edges and collapse internal whitespace runs. */
function collapse(text: string): string {
  return trim(text).replace(/\s+/g, " ");
}

/** Broader equivalence is evidence for diagnostics only, never permission to write. */
function diagnosticFold(text: string): string {
  return collapse(normalize(text).replace(/\p{Default_Ignorable_Code_Point}/gu, "").normalize("NFC"));
}

/** Rank diagnostic windows; only identical text receives a score of 1. */
function lineScore(expected: string, actual: string): number {
  if (expected === actual) return 1;
  if (trimEnd(expected) === trimEnd(actual)) return 0.95;
  if (trim(expected) === trim(actual)) return 0.9;
  if (normalize(expected) === normalize(actual)) return 0.85;
  if (collapse(expected) === collapse(actual)) return 0.6;
  return diagnosticFold(expected) === diagnosticFold(actual) ? 0.55 : 0;
}

interface Window {
  readonly line: number;
  readonly score: number;
  readonly differing: number;
  readonly whitespace: number;
}

function withinBudget(lines: readonly string[], pattern: readonly string[]): boolean {
  return pattern.length > 0 && lines.length * pattern.length <= SCAN_BUDGET;
}

function scanWindows(lines: readonly string[], pattern: readonly string[]): Window[] {
  if (!withinBudget(lines, pattern)) return [];
  const windows: Window[] = [];
  const end = lines.length - pattern.length;
  for (let index = 0; index <= end; index++) {
    let score = 0;
    let differing = 0;
    let whitespace = 0;
    for (let offset = 0; offset < pattern.length; offset++) {
      const [actual, expected] = comparisonPair(lines[index + offset], pattern[offset], index + offset);
      const value = lineScore(expected, actual);
      score += value;
      if (value < 1) {
        differing++;
        if (collapse(expected) === collapse(actual)) whitespace++;
      }
    }
    windows.push({ line: index + 1, score: score / pattern.length, differing, whitespace });
  }
  return windows;
}

function boundedDetails(details: HunkLineDifference[]): Pick<HunkCandidate, "details" | "omittedDifferences"> {
  return {
    details: details.slice(0, MAX_DIFFERENCES),
    ...(details.length > MAX_DIFFERENCES
      ? { omittedDifferences: details.length - MAX_DIFFERENCES }
      : {}),
  };
}

function toCandidate(
  window: Window,
  beforeSearchStart: boolean,
  lines: readonly string[],
  pattern: readonly string[],
): HunkCandidate {
  const details = pattern.flatMap((text, offset) => {
    const index = window.line - 1 + offset;
    const [actual, expected] = comparisonPair(lines[index], text, index);
    return expected === actual
      ? []
      : [{ expectedLine: offset + 1, actualLine: window.line + offset, expected, actual }];
  });
  return {
    line: window.line,
    differing: window.differing,
    whitespace: window.whitespace,
    difference:
      window.differing === 0
        ? "exact"
        : window.whitespace === window.differing
          ? "whitespace"
          : "content",
    beforeSearchStart,
    ...(details.length ? boundedDetails(details) : {}),
  };
}

/** Align only blank-line insertions/deletions between matching nonblank lines. */
function blankLineCandidate(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
): HunkCandidate | undefined {
  if (!withinBudget(lines, pattern) || !trim(pattern[0]) || !trim(pattern.at(-1)!)) return;
  const expected = pattern.flatMap((text, index) => trim(text) ? [{ text, index }] : []);
  if (expected.length < 2) return;
  const actual = lines.flatMap((text, index) => {
    const [logical] = comparisonPair(text, "", index);
    return trim(logical) ? [{ text: logical, index }] : [];
  });
  const keys = expected.map((line) => diagnosticFold(line.text));
  const actualKeys = actual.map((line) => diagnosticFold(line.text));
  for (let index = 0; index + expected.length <= actual.length; index++) {
    const first = actual[index].index;
    if (first < start || !keys.every((key, offset) => key === actualKeys[index + offset])) continue;
    const last = actual[index + expected.length - 1].index;
    const details: HunkLineDifference[] = [];
    let e = 0;
    let a = first;
    let shifted = false;
    while (e < pattern.length || a <= last) {
      let expectedText = pattern[e];
      let actualText = a <= last ? lines[a] : undefined;
      if (actualText !== undefined && expectedText !== undefined)
        [actualText, expectedText] = comparisonPair(actualText, expectedText, a);
      const expectedBlank = expectedText !== undefined && !trim(expectedText);
      const actualBlank = actualText !== undefined && !trim(actualText);
      if (expectedBlank && !actualBlank) {
        details.push({ expectedLine: e + 1, expected: expectedText });
        e++;
        shifted = true;
      } else if (actualBlank && !expectedBlank) {
        details.push({ actualLine: a + 1, actual: actualText });
        a++;
        shifted = true;
      } else {
        if (expectedText !== actualText)
          details.push({ expectedLine: e + 1, actualLine: a + 1, expected: expectedText, actual: actualText });
        e++;
        a++;
      }
    }
    if (!shifted) continue;
    return {
      line: first + 1,
      differing: details.length,
      whitespace: 0,
      difference: "content",
      beforeSearchStart: false,
      lineCount: { expected: pattern.length, actual: last - first + 1 },
      ...boundedDetails(details),
    };
  }
}

/**
 * Closest windows to an unmatched context: at most one exact match that lies
 * before the forward search start, plus the best near miss at or after it.
 */
export function findCandidates(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
): HunkCandidate[] {
  const windows = scanWindows(lines, pattern);
  const candidates: HunkCandidate[] = [];
  const earlier = windows.find((window) => window.line - 1 < start && window.differing === 0);
  if (earlier) candidates.push(toCandidate(earlier, true, lines, pattern));
  const near = windows
    .filter(
      (window) =>
        window.line - 1 >= start && window.differing > 0 && window.score >= MIN_CANDIDATE_SCORE,
    )
    .sort((a, b) => b.score - a.score || a.line - b.line)[0];
  const blank = blankLineCandidate(lines, pattern, start);
  if (blank) candidates.push(blank);
  else if (near) candidates.push(toCandidate(near, false, lines, pattern));
  return candidates;
}

/** Count all windows equal under one projection; 1 when the scan is over budget. */
export function countOccurrences(
  lines: readonly string[],
  pattern: readonly string[],
  pass: number,
): number {
  if (!withinBudget(lines, pattern)) return 1;
  const project = PASSES[pass];
  let count = 0;
  const end = lines.length - pattern.length;
  for (let index = 0; index <= end; index++) {
    let equal = true;
    for (let offset = 0; offset < pattern.length; offset++) {
      if (!equalLine(lines[index + offset], pattern[offset], index + offset, project)) {
        equal = false;
        break;
      }
    }
    if (equal) count++;
  }
  return count;
}

/** Line where a chunk's replacement text already occurs, hinting at a re-application. */
export function findAlreadyApplied(
  lines: readonly string[],
  replacement: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number | undefined {
  if (replacement.length === 0) return undefined;
  const identical =
    replacement.length === pattern.length &&
    replacement.every((line, offset) => line === pattern[offset]);
  if (identical) return undefined;
  const index = seekSequence(lines, replacement, start, endOfFile);
  return index === undefined ? undefined : index + 1;
}

export interface ContextSearch {
  /** Present when an anchor seek itself failed; `pattern` then holds just the anchor. */
  readonly anchor?: string;
  readonly pattern: readonly string[];
  readonly replacement: readonly string[];
  /** 0-based position the forward search started from. */
  readonly start: number;
  readonly endOfFile: boolean;
}

/** Collect every diagnostic for one unmatched chunk. */
export function diagnoseContext(
  lines: readonly string[],
  search: ContextSearch,
): HunkFailure {
  const start = search.endOfFile
    ? Math.max(0, lines.length - search.pattern.length)
    : search.start;
  return {
    anchor: search.anchor,
    pattern: search.pattern,
    searchFrom: start + 1,
    endOfFile: search.endOfFile,
    candidates: findCandidates(lines, search.pattern, start),
    alreadyAppliedAt:
      search.anchor === undefined
        ? findAlreadyApplied(lines, search.replacement, search.pattern, start, search.endOfFile)
        : undefined,
  };
}
