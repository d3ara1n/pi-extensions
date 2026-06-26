# @d3ara1n/pi-subagent

Role-based subagent orchestration for [pi](https://github.com/earendil-works/pi).

Provides a `delegate` tool that lets the main model offload tasks to specialized pi child processes with configurable model roles, real-time TUI progress, and AI-generated summaries.

## Design Philosophy

**The main model is the decision maker; subagents are executors.**

Your primary AI has the most complete context — it knows the full conversation history, project structure, and task at hand. Subagents are spawned with **clean, isolated contexts** to handle specific, well-defined tasks without polluting the main model's context window.

This means:
- **Subagents don't plan** — the main model decides what needs to be done and provides a clear task description
- **Subagents don't orchestrate** — if a task requires multiple steps, the main model examines each result and decides the next move
- **Subagents don't inherit history** — they don't need the full conversation; just a precise task description
- **Multiple subagents can run in parallel** — emit multiple `delegate` calls in one turn; pi executes them concurrently
- **Subagents can nest subagents** — a `worker` can delegate exploration to `explorer` without returning to the main model

> This design intentionally excludes chain pipelines and context-forking — those patterns are better suited when subagents act as advisors (planner, oracle), not executors.

## How it works

1. Main model calls the `delegate` tool with a role and task description
2. The extension resolves the role to a model via pi-model-roles
3. Spawns an isolated pi child process with the configured model, tools, and system prompt
4. **Real-time TUI progress** shows tool calls, turns, and elapsed time as the subagent runs
5. After completion, an **AI-generated one-line summary** is produced for compact display
6. Returns the result to the main model with usage statistics (turns, tokens, cost)

## Built-in Roles

| Role | Model Role | Tools | Can Delegate To | Description |
|------|-----------|-------|-----------------|-------------|
| `explorer` | fast | read, find, grep, glob | — | Fast code search (read-only, no bash) |
| `reviewer` | heavy | read, bash, grep, glob | — | Deep code review (read-only, bash for git/log) |
| `worker` | default | read, bash, edit, write, grep, glob, delegate | explorer, researcher | Implementation — the only role that can modify files |
| `researcher` | fast | web_search, fetch_content, read, bash, delegate | explorer | Web research + GitHub repo analysis |

**Nested delegation**: `worker` and `researcher` can spawn their own subagents. This keeps the main model's context clean — a worker can explore unfamiliar code via an `explorer` subagent without returning intermediate results to the main model.

**Parallel execution**: To run multiple subagents concurrently, emit multiple `delegate` calls in a single turn. Pi's framework executes them in parallel automatically, with each subagent getting its own TUI progress display.

## TUI Display

- **During execution**: Shows role, elapsed time, turn count, and live tool calls
- **Collapsed result**: `✓ explorer · Found login, registration, and token logic` + recent tool calls + usage stats
- **Expanded result** (Ctrl+O): Full task text, all tool calls, final output as rendered Markdown, and usage details

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — model role resolution

## Installation

```bash
pi install @d3ara1n/pi-subagent
```

## Configuration

Edit `~/.pi/agent/settings.json`:

```jsonc
{
  "subagent": {
    // Default timeout per subagent (10 minutes)
    "timeoutMs": 600000,

    // Max subagents running at once; extras queue with a "queued" TUI hint
    "maxConcurrency": 4,

    // Max subagent nesting depth (the main session is depth 0).
    // Default 3 covers worker → researcher → explorer chains.
    "maxDepth": 3,

    // Turn / cost budgets (0 = unlimited). A run is killed once either is hit;
    // partial output is returned with stopReason "budget_exceeded".
    "maxTurns": 0,
    "maxCost": 0,

    // Audit log: one JSON per delegate run under
    // ~/.pi/subagent/history/{sessionId}/{toolCallId}.json
    "history": {
      "enabled": true
    },

    // Summary generation — uses a lightweight model to create
    // a one-line summary for the TUI display.
    // Outputs ≤ 150 chars skip the API call and reuse the text directly.
    "summary": {
      "role": "utility",    // pi-model-roles role for summarization
      "enabled": true        // set false to disable
    }
  }
}
```

All fields are optional. Defaults: `timeoutMs: 600000` (10 min; roles that can `delegate` get 2× automatically when no per-role timeout is set), `maxConcurrency: 4`, `maxDepth: 3`, `maxTurns: 0` (unlimited), `maxCost: 0` (unlimited), `history.enabled: true`, `summary.role: "utility"`, `summary.enabled: true`.

### Agent Overrides

Override, disable, or add subagent roles via `agentOverrides`. Built-in and custom roles are treated equally — all descriptions, examples, and decision triggers feed into the LLM's prompt dynamically.

```jsonc
{
  "subagent": {
    "agentOverrides": {
      // ── Override a built-in role (only specify changed fields) ──
      "worker": {
        "role": "heavy",              // use a stronger model
        "timeoutMs": 600000,          // per-role timeout (overrides global)
        "maxTurns": 50,               // per-role turn budget (0 = unlimited)
        "maxCost": 1.0                // per-role cost ceiling in USD (0 = unlimited)
      },

      // ── Disable a built-in role ──
      "reviewer": {
        "disabled": true
      },

      // ── Add a custom role (all required fields must be provided) ──
      "tester": {
        "role": "default",
        "description": "Test automation & QA — write and run tests, validate fixes. Tools: read, bash, edit, write, grep. Can delegate to explorer.",
        "examples": [
          "Write unit tests for the auth module",
          "Run the test suite and fix failing tests"
        ],
        "decisionTrigger": "Task writes or runs tests?",
        "tools": ["read", "bash", "edit", "write", "grep"],
        "systemPrompt": "QA engineer. Write tests, run them, fix failures. After each change, re-run affected tests."
      }
    }
  }
}
```

**Required fields for custom roles:** `role`, `description`, `examples`, `decisionTrigger`, `tools`, `systemPrompt`.

**Optional fields:** `subagentRoles` (roles this role can spawn via delegate), `timeoutMs` (per-role timeout override; when unset, delegate-capable roles get 2× the global default automatically), `maxTurns` / `maxCost` (per-role budget overrides; 0 = unlimited), `fallbackRole` (backup pi-model-roles role on provider errors).

Invalid custom roles (missing required fields) are silently skipped with an error notification at session start.

## Usage (by the main model)

Delegate tasks that would generate many tool calls or verbose output to keep your own context clean:

```json
{
  "role": "explorer",
  "task": "Find all files that import the ModelRegistry and trace how they use it"
}
```

**Role-specific examples:**

| Role | Example task | Why delegate? |
|------|-------------|---------------|
| `explorer` | `"Map the routing structure of src/api/"` | You only need the conclusion, not every grep result |
| `reviewer` | `"Review error handling in auth.ts for security issues"` | Review output is longform; keep it isolated |
| `worker` | `"Rename all snake_case fields to camelCase in src/models/"` | Your context stays focused on high-level intent |
| `researcher` | `"Find the React 19 migration guide and summarize breaking changes"` | Search results are noisy; get a clean summary |

**Parallel usage:** emit multiple `delegate` calls in a single turn:

```json
[
  { "role": "explorer", "task": "Map the repository structure" },
  { "role": "researcher", "task": "Find latest docs on the library used here" }
]
```

### Passing extra context

The optional `context` field lets you hand a subagent precise context — selected code, a prior delegate's result, a file list, a git diff — without inflating the `task` string. It's prepended before the task:

```json
{
  "role": "worker",
  "task": "Add input validation to the login function",
  "context": "Current implementation (src/auth.ts:42-70):\n```ts\nasync function login(email, pw) { ... }\n```\nValidation must reject empty/invalid emails and enforce a min 8-char password."
}
```

The stored/displayed task stays as the original `task`; the `context` is merged into the prompt the subagent receives.

### Budget enforcement

`maxTurns` / `maxCost` cap a run. When exceeded, the child is killed and the last completed output is returned with `stopReason: "budget_exceeded"` (shown in the expanded TUI). Defaults are unlimited (0); set global defaults in config or per-role via `agentOverrides`.

### Oversized outputs

When a run's output exceeds the size limit (50,000 chars), pi-subagent first tries to **compress** it with the summary model (same role configured under `summary.role`) into a compact form that preserves conclusions, code, file paths, and errors. If compression fails or doesn't shrink enough, it falls back to mechanical head+tail truncation. The prepared text is what the main model receives and what the expanded TUI renders; a hint line notes which method was used. The **full raw output is always kept in the history file** for auditing.

### Run history

Every completed delegate run is written (best-effort) to `~/.pi/subagent/history/{sessionId}/{toolCallId}.json`, recording role, task, usage, activity log, and the **full raw output** (even when the main model saw a compressed/truncated version). Useful for auditing what subagents did and how much they cost. Disable with `history.enabled: false`.

## License

MIT
