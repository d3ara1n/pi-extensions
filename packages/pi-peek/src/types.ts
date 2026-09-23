/** Public contracts for ephemeral, read-only session investigations. */

export interface PeekConfig {
  /** Total deadline per question, including authentication, model requests and retrieval. */
  timeoutMs?: number;
  /** A tool-capable model role resolved by pi-model-roles. Thinking is optional. */
  role?: string;
  /** Maximum successful model requests per question, including the final report. */
  maxRounds?: number;
  /** Per-request output allowance, capped by the selected model's capabilities. */
  maxOutputTokens?: number;
}

export const DEFAULT_PEEK_CONFIG: Required<PeekConfig> = {
  timeoutMs: 90_000,
  role: "utility",
  maxRounds: 6,
  maxOutputTokens: 8192,
};

export interface MainAgentStatus {
  activity: string;
  toolName?: string;
  toolIndex: number;
  turn: number;
  lastUpdated: string;
}

export interface PeekReferenceOptions {
  /** Include readable thinking actually saved in the source session. Default false. */
  includeThinking?: boolean;
}

export type InvestigateStage =
  | "investigating"
  | "thinking"
  | "searching"
  | "reading"
  | "outputting"
  | "retrying"
  | "done"
  | "error";

export interface InvestigateMetrics {
  /** Model requests started, including overflow retries. */
  requests: number;
  /** Internal search/read tool calls executed. */
  toolCalls: number;
  elapsedMs: number;
}

export interface InvestigateProgress {
  stage: InvestigateStage;
  phase: "investigation" | "report";
  /** Current non-overflow model round. */
  round: number;
  maxRounds: number;
  request: number;
  toolCalls: number;
  model: string;
  /** Report characters emitted so far; never includes thinking or private investigation text. */
  chars: number;
  elapsedMs: number;
}

export interface InvestigateOptions {
  /** Parsed report-body deltas, or one last-text-block fallback at completion. */
  onToken?: (delta: string) => void;
  /** Discard provisional report text when its model response goes on to request tools. */
  onReset?: () => void;
  onStage?: (stage: InvestigateStage) => void;
  /** State snapshots at phase/activity changes and periodically during report output. */
  onProgress?: (progress: InvestigateProgress) => void;
  signal?: AbortSignal;
}

export interface InvestigateResult {
  /** Model report only; limit notices are separate metadata. */
  report: string;
  summary?: string;
  reportMode?: "tagged" | "fallback";
  /** Character length of the outline supplied with the final model request. */
  referenceLength: number;
  snapshotAt: string;
  model: string;
  metrics?: InvestigateMetrics;
  /** A length stop preserves the partial report without automatically continuing. */
  stopReason: "stop" | "length";
  /** Usage is summed across retrieval, reporting and any overflow retries. */
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
  };
}

/** Local or provider context overflow; prior successful investigation turns remain intact. */
export class PeekContextOverflowError extends Error {
  readonly code = "context_overflow";
  constructor(message = "Context limit reached.", cause?: unknown) {
    super(message, { cause });
    this.name = "PeekContextOverflowError";
  }
}

export interface PeekInvestigation {
  readonly snapshotAt: string;
  /** Bounded retrieval over a fixed snapshot; follow-ups retain prior questions/reports. */
  investigate(question: string, opts?: InvestigateOptions): Promise<InvestigateResult>;
  /** Abort pending work and release the snapshot and history. Idempotent. */
  dispose(): void;
}

export interface PeekAPI {
  /** Pin the current branch, thinking inclusion and resolved model for follow-ups. */
  createInvestigation(options?: PeekReferenceOptions): PeekInvestigation;
  /** One question in a temporary investigation, disposed after completion or failure. */
  investigate(
    question: string,
    opts?: InvestigateOptions & PeekReferenceOptions,
  ): Promise<InvestigateResult>;
  /** Full admitted snapshot text for explicit serialization; model requests use a bounded outline. */
  serializeMainConversation(options?: PeekReferenceOptions): string;
  getMainAgentStatus(): MainAgentStatus;
}

export const PEEK_GLOBAL_KEY = "__piPeek";
