/**
 * Subagent configuration and types.
 */

/** Configuration for the subagent extension. */
export interface SubagentConfig {
  /** Max concurrent subagents. `0` means unlimited; negative values are normalized to `0`. Extras queue with a TUI hint when this is positive. */
  maxConcurrency: number;
  /** Max subagent nesting depth (the top-level session is depth 0). `0` means unlimited; negative values are normalized to `0`. */
  maxDepth: number;
  /** Default assistant-turn budget. `0` means unlimited; negative values are normalized to `0`. Per-role maxTurns overrides this. */
  maxTurns: number;
  /** Default cumulative cost budget in USD. `0` means unlimited; negative values are normalized to `0`. Per-role maxCost overrides this. */
  maxCost: number;
  /** Persist every spawned delegate run (finished/failed/aborted alike) to ~/.pi/subagent/history/{sessionId}/{toolCallId}.json for auditing. Pre-run failures that never spawned are not recorded. */
  history: SubagentHistoryConfig;
  summary: SubagentSummaryConfig;
  /** Limits optional serialized parent-conversation inheritance. */
  inheritance: SubagentInheritanceConfig;
  /**
   * Per-role overrides from settings.json. Keyed by role name.
   * - Override built-in roles: provide fields to merge.
   * - Disable built-in roles: set `disabled: true`.
   */
  agentOverrides: Record<string, Partial<SubagentRole> & { disabled?: boolean }>;
}

export interface SubagentHistoryConfig {
  enabled: boolean;
}

export interface SubagentSummaryConfig {
  role: string;
  enabled: boolean;
}

export interface SubagentInheritanceConfig {
  /** Maximum characters in the inherited-conversation body. */
  maxChars: number;
}

export const DEFAULT_CONFIG: SubagentConfig = {
  maxConcurrency: 4,
  maxDepth: 3,
  maxTurns: 0,
  maxCost: 0,
  history: { enabled: true },
  summary: { role: "utility", enabled: true },
  inheritance: { maxChars: 50_000 },
  agentOverrides: {},
};

/** A built-in subagent role definition. */
export interface SubagentRole {
  /** pi-model-roles role name to use for this subagent */
  role: string;
  /** One-line description for the LLM prompt — what this role does and what tools it has */
  description: string;
  /** Example tasks to show in CONCRETE EXAMPLES section */
  examples: string[];
  /** Decision flow trigger phrase, e.g. "Task modifies files?" */
  decisionTrigger: string;
  /** System prompt for the subagent */
  systemPrompt: string;
  /**
   * Tools available to this subagent — exact-name allowlist mapped to pi's `--tools`.
   * Absent = all tools (no restriction); empty array = literally zero tools (`--no-tools`).
   * Mutually exclusive with `excludeTools`.
   */
  tools?: string[];
  /**
   * Tools withheld from this subagent — everything else stays available (mapped
   * to pi's `--exclude-tools`). Absent or empty = no restriction.
   * Mutually exclusive with `tools`.
   */
  excludeTools?: string[];
  /** If this role has `delegate`, restrict which roles it may spawn. undefined = no restriction. */
  subagentRoles?: string[];
  /** Per-role active-time timeout in seconds. `0` or unset means unlimited; negative values are normalized to `0`. */
  timeout?: number;
  /** Max assistant turns before the run is killed. `0` means unlimited; negative values are normalized to `0`. */
  maxTurns?: number;
  /** Max cumulative cost in USD. `0` means unlimited; negative values are normalized to `0`. */
  maxCost?: number;
  /** Fallback pi-model-roles role name to retry the whole run on when this role's model hits a provider error. Unset = no retry (the failure stands). */
  fallbackRole?: string;
}

/** Status of an individual tool call within a subagent run. */
export type ToolStatus = "running" | "done" | "failed";

/** A single entry in the real-time activity log (thinking block, tool call, streamed assistant text, or a user steer). */
export interface ActivityEntry {
  kind: "thinking" | "toolCall" | "text" | "steer";
  /** Synthetic id (thinking-N / text-N / steer-N) or the toolCallId from the event stream. */
  id: string;
  status: ToolStatus;
  /** Tool name + args (toolCall only). */
  toolName?: string;
  args?: Record<string, any>;
  /** Accumulated streamed assistant text or the injected steer message (kinds "text"/"steer"). Grows in place until message_end freezes text entries. */
  text?: string;
}

/** Live control channel into a spawned child process (wired to the RPC stdin). */
export interface SubagentControl {
  /** Queue a steering message — delivered after the child's current tool batch, before its next LLM call. No-op after the process exits. */
  steer(message: string): void;
}

/** Usage statistics from a subagent execution. */
export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** A message from the child's JSON event stream (parsed for usage/output extraction). */
export interface SubagentMessage {
  role: string;
  content: Array<{
    type: string;
    text?: string;
    name?: string;
    arguments?: Record<string, any>;
    id?: string;
  }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
    totalTokens?: number;
  };
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
}

/** Result from a single subagent execution. */
export interface SubagentResult {
  /** Which subagent role was used */
  role: string;
  /** The task that was assigned */
  task: string;
  /** Process exit code (-1 = still running for streaming) */
  exitCode: number;
  /** True while waiting for a concurrency slot (TUI hint only). */
  queued?: boolean;
  /** How `output` was prepared for display: raw, compressed by summary model, or mechanically truncated. */
  outputMethod?: "raw" | "compressed" | "truncated";
  /** Last assistant text output */
  output: string;
  /** AI-generated one-line summary for TUI display */
  summary?: string;
  /** stderr output */
  stderr: string;
  /** Token usage stats */
  usage: SubagentUsage;
  /** Model identifier used */
  model?: string;
  /** Stop reason from last message */
  stopReason?: string;
  /** Error message if failed */
  errorMessage?: string;
  /** Present when the first attempt hit a provider error and the whole run was retried on the fallback role: what the first attempt ran on and why it failed. The retry overwrites every other trace, so this is the only record of the first attempt. */
  fallbackFrom?: FallbackFrom;
  /** Real-time activity log: thinking blocks and tool calls in arrival order. */
  activityLog: ActivityEntry[];

  // ── TUI rendering helpers (not produced by the child; filled in by the execute layer) ──
  /** Wall-clock start time; present only on queued/running frames so the TUI can compute live elapsed time. Absent on terminal frames. */
  startTime?: number;
  /** Total elapsed time (ms) for terminal frames, written by execute when the run ends; spans the whole delegate interval (incl. fallback retries). */
  elapsedMs?: number;
  /** Active-time timeout budget (ms) for this run; present on running frames so the TUI can show "elapsed/budget". */
  budgetMs?: number;
  /** Accumulated ms the child spent inside nested `delegate` calls (display only; never changes the timeout verdict). Shown as "+Ns" in the TUI. */
  graceMs?: number;
  /** Wall-clock start (ms) of the currently-open delegate suspend; 0/absent when not suspended. The TUI adds (now - pauseStart) to graceMs for a live +Ns counter (same render path as elapsed seconds). */
  pauseStart?: number;
  /** Reference file paths passed to delegate (params.files); used by the expanded view. */
  files?: string[];
  /** Extra context passed to delegate (params.context); used by the expanded view. */
  context?: string;
  /** True when this run received a filtered parent-conversation snapshot. */
  inheritConversation?: boolean;
  /** Delivered inherited-conversation body size; safe metadata only, never the body itself. */
  inheritedConversationChars?: number;
  /** True when the inherited body was mechanically shortened to its configured limit. */
  inheritedConversationTruncated?: boolean;
}

/** Snapshot of a failed first attempt that was retried on the fallback role. */
export interface FallbackFrom {
  /** Model identifier the first attempt ran on. */
  model?: string;
  /** Stop reason of the first attempt. */
  stopReason?: string;
  /** Human-readable error message of the first attempt. */
  errorMessage?: string;
  /** Tail of the first attempt's stderr, truncated for diagnostics. */
  stderrTail?: string;
}

/** TUI details for a foreground delegate tool result/update: one result per call. */
export interface SubagentDetails {
  results: SubagentResult[];
}

// ── Background delegation (delegate background:true / wait / check) ──────

/** Lifecycle state of a delegation run, derived from the latest snapshot frame. */
export type RunState = "queued" | "running" | "finished" | "failed";

/** Details for a background delegate result — the input snapshot for the TUI's static input block. */
export interface BackgroundDelegateDetails {
  /** Registry id (sub-N) the model uses with wait/check. */
  id: string;
  role: string;
  task: string;
  context?: string;
  files?: string[];
  inheritConversation?: boolean;
  inheritedConversationChars?: number;
  inheritedConversationTruncated?: boolean;
}

/** One watched run inside a wait/check view. */
export interface RunViewEntry {
  id: string;
  role: string;
  /** Live frame while running, terminal result once finished. */
  result: SubagentResult;
}

/** Details for wait tool updates/results — the combined live view of all watched runs. */
export interface WaitDetails {
  entries: RunViewEntry[];
  /** True when the wait timed out with unfinished runs (marks the tool result as an error). */
  timedOut?: boolean;
}

/** Details for a check tool result — a frozen one-shot snapshot of a single run. */
export interface CheckDetails {
  id: string;
  role: string;
  result: SubagentResult;
}

/**
 * Details for a cancel tool result — same shape as check: the run's terminal
 * frame. Renders with the confirmation-only view: the stop summary and the
 * reason, never the partial output (check is the result-fetcher).
 */
export type CancelDetails = CheckDetails;

/**
 * Details for a steer tool result — the echoed correction. Collapsed shows
 * icon + first line; expanded shows the full message plus the delivery hint
 * (check is the result-fetcher for the effect, never this row).
 */
export interface SteerDetails {
  id: string;
  role: string;
  message: string;
}

/**
 * Details for the background-run completion notice (custom message
 * `subagent-completion`). The renderer lays these out as a structured notice
 * card; the message's plain `content` string stays as the non-TUI fallback
 * (export, print mode) and for sessions persisted before this shape existed
 * (task absent there).
 */
export interface CompletionNoticeDetails {
  /** Registry id (sub-N). */
  id: string;
  role: string;
  outcome: "finished" | "failed" | "cancelled";
  /** Full task text; the renderer flattens and truncates it. */
  task?: string;
}
