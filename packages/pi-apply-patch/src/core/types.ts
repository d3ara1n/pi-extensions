/** Facts shared by model-facing text and terminal rendering. */
export interface PatchNotice {
  readonly kind: "repair" | "warning";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  /** Original patch line for repairs; source line for match warnings. */
  readonly line?: number;
  readonly hunk?: number;
  readonly count?: number;
}

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

/** Row-level exact occurrence breakdown for one context line in a no-candidate failure. */
export interface ContextLineHit {
  /** Zero-based index into the failure pattern. */
  readonly index: number;
  /** Exact occurrences of this single line in the file. */
  readonly occurrences: number;
  /** First 1-based line where this line occurs, when it occurs. */
  readonly firstAt?: number;
}

/** Why one update chunk did not match; used verbatim in tool error reports. */
export interface HunkFailure {
  /** Anchor text whose seek failed, when the anchor itself is the failure. */
  readonly anchor?: string;
  /** Context lines actually searched, after Codex's trailing-empty adjustment. */
  readonly pattern: readonly string[];
  /** 1-based source line the forward search started from. */
  readonly searchFrom: number;
  /** The constraint that established the search start. */
  readonly searchBoundary: "start" | "hunk" | "anchor" | "eof";
  /** True when the chunk carried *** End of File, so only the last window was searched. */
  readonly endOfFile: boolean;
  /** Closest windows in the file, most explanatory first. */
  readonly candidates: readonly HunkCandidate[];
  /** 1-based line where the chunk's replacement text already occurs, when found. */
  readonly alreadyAppliedAt?: number;
  /** Exact occurrences of the whole pattern in the file; set only when no candidate was found. */
  readonly patternOccurrences?: number;
  /** Per-line exact occurrences; set only when no candidate was found. */
  readonly contextLineHits?: readonly ContextLineHit[];
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
  /** All exact match lines before the search start, when more than one. */
  readonly earlierMatches?: readonly number[];
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
