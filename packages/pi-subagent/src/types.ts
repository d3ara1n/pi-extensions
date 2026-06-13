/**
 * Subagent configuration and types.
 */

/** Configuration for the subagent extension. */
export interface SubagentConfig {
  timeoutMs: number;
  summary: SubagentSummaryConfig;
  /**
   * Per-role overrides from settings.json. Keyed by role name.
   * - Override built-in roles: provide fields to merge.
   * - Disable built-in roles: set `disabled: true`.
   */
  agentOverrides: Record<string, Partial<SubagentRole> & { disabled?: boolean }>;
}

export interface SubagentSummaryConfig {
  role: string;
  enabled: boolean;
}

export const DEFAULT_CONFIG: SubagentConfig = {
  timeoutMs: 300_000,
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
}

/** TUI details structure passed via tool result details. */
export interface SubagentDetails {
  mode: "single";
  results: SubagentResult[];
}
