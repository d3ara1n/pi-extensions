import type { FileOperation, HunkCandidate, HunkFailure, HunkOutcome } from "./core/types.ts";
import { DiagnosticText } from "./diagnostic-text.ts";

/** Per-file reporting budget: keep model-facing failures actionable, not overwhelming. */
const MAX_FAILED_HUNKS = 6;
const MAX_ECHO_LINES = 6;
const MAX_EARLIER_MATCHES = 6;
const MAX_VERIFIED_LISTED = 12;

export interface RejectedFile {
  /** Path as written in the patch. */
  readonly path: string;
  readonly kind: FileOperation["kind"];
  /** Error text for non-matching failures (read, path, or target errors). */
  readonly reason: string;
  /** Per-hunk outcomes when the failure is context matching. */
  readonly outcomes?: readonly HunkOutcome[];
}

export interface RejectionReport {
  readonly rejected: readonly RejectedFile[];
  /** Paths that verified but were not written because the whole patch was rejected. */
  readonly verified: readonly string[];
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Bounded echo of the pattern: whole when short, otherwise first and last lines. */
function echoPattern(pattern: readonly string[], text: DiagnosticText): string[] {
  if (pattern.length <= MAX_ECHO_LINES) return pattern.map((line) => text.visibleText(line));
  return [
    ...pattern.slice(0, 3).map((line) => text.visibleText(line)),
    `… ${pattern.length - MAX_ECHO_LINES} of ${pattern.length} lines omitted`,
    ...pattern.slice(-3).map((line) => text.visibleText(line)),
  ];
}

function candidateLine(candidate: HunkCandidate, failure: HunkFailure): string {
  if (candidate.lineCount)
    return `closest match at line ${candidate.line}: blank-line alignment differs (expected ${candidate.lineCount.expected} lines, actual ${candidate.lineCount.actual} lines)`;
  if (candidate.difference === "exact") {
    if (candidate.earlierMatches && candidate.earlierMatches.length > 1) {
      const lines = candidate.earlierMatches;
      const shown = lines.slice(0, MAX_EARLIER_MATCHES).join(", ");
      const more =
        lines.length > MAX_EARLIER_MATCHES ? `, … ${lines.length - MAX_EARLIER_MATCHES} more` : "";
      return `context matches at lines ${shown}${more} before the search start; the match is ambiguous — add surrounding context to identify the intended occurrence`;
    }
    const hint =
      failure.searchBoundary === "eof"
        ? "; this match is not at the end of the file — check the *** End of File constraint"
        : failure.searchBoundary === "anchor"
          ? "; this match is at or before the @@ anchor — check the anchor and intended context"
          : failure.searchBoundary === "hunk"
            ? "; move this hunk earlier (hunks must be in file order)"
            : "";
    return `context matches at line ${candidate.line}, outside the searched range${hint}`;
  }
  const kind =
    candidate.difference === "whitespace" ? "whitespace-only drift" : "content differences";
  return `closest match at line ${candidate.line}: ${candidate.differing} of ${failure.pattern.length} context lines changed (${kind})`;
}

function hunkLines(hunk: number, failure: HunkFailure, text: DiagnosticText): string[] {
  const searched = failure.endOfFile
    ? "anchored to the end of the file"
    : `search started at line ${failure.searchFrom}`;
  const rows: string[] =
    failure.anchor !== undefined
      ? [`hunk ${hunk}: anchor ${text.visibleText(failure.anchor)} not found (${searched})`]
      : [`hunk ${hunk}: context lines not found (${searched})`, "expected:"];
  if (failure.anchor === undefined)
    for (const line of echoPattern(failure.pattern, text)) rows.push(`| ${line}`);
  for (const candidate of failure.candidates) {
    rows.push(candidateLine(candidate, failure));
    for (const detail of candidate.details ?? [])
      rows.push(...text.describeDifference(detail).map((line) => `  ${line}`));
    if (candidate.omittedDifferences)
      rows.push(`  … ${candidate.omittedDifferences} more differing lines omitted`);
  }
  if (failure.alreadyAppliedAt !== undefined)
    rows.push(
      `the replacement text already occurs at line ${failure.alreadyAppliedAt}; this hunk may already be applied`,
    );
  return rows;
}

function fileSection(file: RejectedFile, text: DiagnosticText): string[] {
  if (!file.outcomes) return [`${file.path} (${file.kind}): ${file.reason}`];
  const failed = file.outcomes.filter(
    (outcome): outcome is Extract<HunkOutcome, { status: "unmatched" }> =>
      outcome.status === "unmatched",
  );
  const rows = [
    `${file.path} (${file.kind}): ${failed.length} of ${file.outcomes.length} hunks did not match`,
  ];
  for (const outcome of failed.slice(0, MAX_FAILED_HUNKS))
    rows.push(...hunkLines(outcome.hunk, outcome.failure, text).map((line) => `  ${line}`));
  if (failed.length > MAX_FAILED_HUNKS)
    rows.push(`  … ${plural(failed.length - MAX_FAILED_HUNKS, "more failed hunk")}`);
  return rows;
}

/** Render the aggregate verification failure for every operation in one bounded report. */
export function renderRejection(report: RejectionReport): string {
  const text = new DiagnosticText();
  const sections = report.rejected.map((file) => fileSection(file, text));
  if (report.verified.length) {
    const listed = report.verified.slice(0, MAX_VERIFIED_LISTED).join(", ");
    const overflow =
      report.verified.length > MAX_VERIFIED_LISTED
        ? `, … ${plural(report.verified.length - MAX_VERIFIED_LISTED, "more")}`
        : "";
    sections.push([`verified but not written (whole patch rejected): ${listed}${overflow}`]);
  }
  const total = report.rejected.length + report.verified.length;
  return [
    `apply_patch verification failed: ${report.rejected.length} of ${total} operations failed; no files were written.`,
    ...(text.hasEscapes
      ? ["Quoted text uses diagnostic escapes; patch lines must contain the literal characters, not these escape sequences."]
      : []),
    "",
    ...sections.flatMap((section) => [...section, ""]),
  ]
    .join("\n")
    .trimEnd();
}
