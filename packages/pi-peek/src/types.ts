/** Public contracts for ephemeral, active-context session investigations. */

export interface PeekConfig {
  /** Total deadline per question, including authentication and streaming. */
  timeoutMs?: number;
  /** A large-context model role resolved by pi-model-roles. */
  role?: string;
}

export const DEFAULT_PEEK_CONFIG: Required<PeekConfig> = {
  timeoutMs: 90_000,
  role: "utility",
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

export type InvestigateStage = "investigating" | "done" | "error";

export interface InvestigateOptions {
  onToken?: (delta: string) => void;
  onStage?: (stage: InvestigateStage) => void;
  signal?: AbortSignal;
}

export interface InvestigateResult {
  /** Model report only; limit notices are separate metadata. */
  report: string;
  referenceLength: number;
  snapshotAt: string;
  model: string;
  /** A length stop preserves the partial report without automatically continuing. */
  stopReason: "stop" | "length";
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
  };
}

/** Upstream context overflow; prior successful investigation turns remain intact. */
export class PeekContextOverflowError extends Error {
  readonly code = "context_overflow";
  constructor(message = "Context limit reached.", cause?: unknown) {
    super(message, { cause });
    this.name = "PeekContextOverflowError";
  }
}

export interface PeekInvestigation {
  readonly snapshotAt: string;
  /** One stream request per question, using the full fixed reference and prior reports. */
  investigate(question: string, opts?: InvestigateOptions): Promise<InvestigateResult>;
  /** Abort pending work and release the snapshot and history. Idempotent. */
  dispose(): void;
}

export interface PeekAPI {
  /** Pin the current branch, thinking inclusion and resolved model for follow-ups. */
  createInvestigation(options?: PeekReferenceOptions): PeekInvestigation;
  /** One question in a temporary investigation, disposed after completion or failure. */
  investigate(question: string, opts?: InvestigateOptions & PeekReferenceOptions): Promise<InvestigateResult>;
  /** Active-context text reference (compaction-aware view); never locally truncated. */
  serializeMainConversation(options?: PeekReferenceOptions): string;
  getMainAgentStatus(): MainAgentStatus;
}

export const PEEK_GLOBAL_KEY = "__piPeek";
