/**
 * Subagent configuration and types.
 */

/** Configuration for the subagent extension. */
export interface SubagentConfig {
  /** Default timeout in milliseconds for subagent processes */
  timeoutMs: number;
}

export const DEFAULT_CONFIG: SubagentConfig = {
  timeoutMs: 300_000, // 5 minutes
};

/** A built-in subagent role definition. */
export interface SubagentRole {
  /** pi-model-roles role name to use for this subagent */
  role: string;
  /** System prompt for the subagent */
  systemPrompt: string;
  /** Tools available to this subagent */
  tools: string[];
}

/** Result from a subagent execution. */
export interface SubagentResult {
  /** Which subagent role was used */
  role: string;
  /** The task that was assigned */
  task: string;
  /** Process exit code */
  exitCode: number;
  /** Extracted text output */
  output: string;
  /** stderr output */
  stderr: string;
  /** Token usage stats */
  usage: {
    input: number;
    output: number;
    cost: number;
    turns: number;
  };
  /** Model used */
  model?: string;
  /** Stop reason */
  stopReason?: string;
  /** Error message if failed */
  errorMessage?: string;
}
