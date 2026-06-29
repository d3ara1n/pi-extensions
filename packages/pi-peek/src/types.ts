/**
 * pi-peek shared types.
 *
 * @d3ara1n/pi-peek is a dependency library providing LOCAL consult capability:
 * serialize the main conversation + answer questions via the utility model
 * (read-after-burn, never touches the main session). It registers hooks for
 * the tracker but NO tools/commands and NO cross-instance machinery.
 *
 * Cross-instance transport (UDS) and peer discovery live in @d3ara1n/pi-peek-agent,
 * which consumes this local capability to serve remote asks.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PeekConfig {
  /** Serialize: keep the most recent N user-initiated turns. */
  recentTurns?: number;
  /** Serialize: hard cap on total serialized characters. */
  maxChars?: number;
  /** Serialize: truncate a single tool result longer than this. */
  toolResultLimit?: number;
  /** Model role to use for consult (resolved via pi-model-roles). Default: "utility". */
  role?: string;
}

export const DEFAULT_PEEK_CONFIG: Required<
  Pick<PeekConfig, "recentTurns" | "maxChars" | "toolResultLimit" | "role">
> = {
  recentTurns: 10,
  maxChars: 50_000,
  toolResultLimit: 500,
  role: "utility",
};

// ---------------------------------------------------------------------------
// Tracker — live snapshot of the local main agent
// ---------------------------------------------------------------------------

export interface MainAgentStatus {
  /** Human-readable current activity, e.g. "executing bash: npm test". */
  activity: string;
  /** Name of the tool currently executing, if any. */
  toolName?: string;
  /** Which tool call within the current turn (1-based). */
  toolIndex: number;
  /** Current turn index. */
  turn: number;
  /** ISO timestamp of the last update. */
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// investigate() — entry-point-agnostic consult core (no session/UI dependency)
// ---------------------------------------------------------------------------

export interface InvestigateOptions {
  /** Pre-serialized reference text. If omitted, the caller serializes. */
  referenceText?: string;
  /** Streaming token callback. */
  onToken?: (delta: string) => void;
  /** Stage change callback: "investigating" | "done" | "error". */
  onStage?: (stage: string) => void;
  /** Abort the investigation. */
  signal?: AbortSignal;
  /** Model role to use for consult (resolved via pi-model-roles). Overrides config default. */
  role?: string;
}

export interface InvestigateResult {
  answer: string;
  /** Number of characters of reference text fed in. */
  referenceLength: number;
  /** Utility model that answered ("provider/id"). */
  model?: string;
  /** Utility model token usage for this consult. */
  usage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
}

// ---------------------------------------------------------------------------
// PeekAPI — the singleton surface consumers use (LOCAL capability only)
// ---------------------------------------------------------------------------

export interface PeekAPI {
  /** Serialize this instance's main conversation branch to reference text. */
  serializeMainConversation(): string;
  /** One-shot consult: serialize + stream to utility model (read-after-burn). */
  investigate(question: string, opts?: InvestigateOptions): Promise<InvestigateResult>;
  /** Current local main-agent tracker snapshot. */
  getMainAgentStatus(): MainAgentStatus;
}

/** Global key for the PeekAPI singleton (survives module identity mismatches). */
export const PEEK_GLOBAL_KEY = "__piPeek";
