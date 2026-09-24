/** A Codex update chunk with LF-separated patch text. */
export interface Chunk {
  readonly anchor?: string;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  /** Old-line offsets for unchanged context; null marks an explicitly added line. */
  readonly newLineSources?: readonly (number | null)[];
  readonly endOfFile: boolean;
}

export type FileOperation =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly moveTo?: string;
      readonly chunks: readonly Chunk[];
    };

export interface ParsedPatch {
  readonly operations: readonly FileOperation[];
}

/** Which comparison produced a match, in Codex's fixed precision order. */
export type MatchStrategy = "exact" | "trim_end" | "trim" | "unicode";

/** A successfully matched update chunk. */
export interface HunkMatchInfo {
  /** 1-based hunk number within the file's update operation. */
  readonly hunk: number;
  /** 1-based source line where the context matched (insertion line for pure additions). */
  readonly line: number;
  readonly strategy: MatchStrategy;
  /** How many times the context occurs in the file; matching picks the first. */
  readonly occurrences: number;
}

/** Why one update chunk did not match; used verbatim in tool error reports. */
export interface HunkFailure {
  /** Anchor text whose seek failed, when the anchor itself is the failure. */
  readonly anchor?: string;
  /** Context lines actually searched, after Codex's trailing-empty adjustment. */
  readonly pattern: readonly string[];
  /** 1-based source line the forward search started from. */
  readonly searchFrom: number;
  /** True when the chunk carried *** End of File, so only the last window was searched. */
  readonly endOfFile: boolean;
  /** Closest windows in the file, most explanatory first. */
  readonly candidates: readonly HunkCandidate[];
  /** 1-based line where the chunk's replacement text already occurs, when found. */
  readonly alreadyAppliedAt?: number;
}

/** The closest window to an unmatched context; diagnostics only, never applied. */
export interface HunkCandidate {
  /** 1-based source line where the candidate window starts. */
  readonly line: number;
  /** Context lines that are not an exact character-for-character match. */
  readonly differing: number;
  /** Differing lines that agree once whitespace runs collapse (indentation or spacing drift). */
  readonly whitespace: number;
  readonly difference: "exact" | "whitespace" | "content";
  /** The candidate lies before the position the hunk's forward search started from. */
  readonly beforeSearchStart: boolean;
  /** Bounded examples of the actual differences, never used for matching. */
  readonly details?: readonly HunkLineDifference[];
  readonly omittedDifferences?: number;
  /** Present when diagnostic alignment found inserted or missing blank lines. */
  readonly lineCount?: { readonly expected: number; readonly actual: number };
}

export interface HunkLineDifference {
  /** 1-based line within the expected context; absent for an extra source line. */
  readonly expectedLine?: number;
  /** 1-based source line; absent for a missing source line. */
  readonly actualLine?: number;
  readonly expected?: string;
  readonly actual?: string;
}

/** Per-chunk outcome of matching one file's update operation. */
export type HunkOutcome =
  | ({ readonly status: "matched" } & HunkMatchInfo)
  | { readonly status: "unmatched"; readonly hunk: number; readonly failure: HunkFailure };
