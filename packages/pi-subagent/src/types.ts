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
  /** Persist each delegate run to ~/.pi/subagent/history/{sessionId}/{id}.json for auditing. */
  history: SubagentHistoryConfig;
  summary: SubagentSummaryConfig;
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

export const DEFAULT_CONFIG: SubagentConfig = {
  maxConcurrency: 4,
  maxDepth: 3,
  maxTurns: 0,
  maxCost: 0,
  history: { enabled: true },
  summary: { role: "utility", enabled: true },
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
  /** Tools available to this subagent */
  tools: string[];
  /** If this role has `delegate`, restrict which roles it may spawn. undefined = no restriction. */
  subagentRoles?: string[];
  /** Per-role active-time timeout in seconds. `0` or unset means unlimited; negative values are normalized to `0`. */
  timeout?: number;
  /** Max assistant turns before the run is killed. `0` means unlimited; negative values are normalized to `0`. */
  maxTurns?: number;
  /** Max cumulative cost in USD. `0` means unlimited; negative values are normalized to `0`. */
  maxCost?: number;
  /** Fallback pi-model-roles role name when this role's model is unavailable (provider error). Defaults to "default". */
  fallbackRole?: string;
}

/** Status of an individual tool call within a subagent run. */
export type ToolStatus = "running" | "done" | "failed";

/** A single entry in the real-time activity log (thinking block or tool call). */
export interface ActivityEntry {
  kind: "thinking" | "toolCall";
  /** Synthetic id (thinking-N) or the toolCallId from the event stream. */
  id: string;
  status: ToolStatus;
  /** Tool name + args (toolCall only). */
  toolName?: string;
  args?: Record<string, any>;
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

/** A message from the subagent's JSON event stream. */
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
  /** All messages from the event stream (assistant + tool results) */
  messages: SubagentMessage[];
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
}

/** TUI details structure passed via tool result details. */
export interface SubagentDetails {
  mode: "single";
  results: SubagentResult[];
}
