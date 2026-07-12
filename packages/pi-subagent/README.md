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

> This design currently focuses on single-task delegation rather than chain pipelines or context-forking — those patterns fit better when subagents act as advisors (planner, oracle) rather than executors.

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
| `explorer` | fast | read, find, grep | — | Fast code search (read-only, no bash) |
| `reviewer` | heavy | read, bash, grep, find | — | Deep code review (read-only, bash for git/log) |
| `worker` | default | read, bash, edit, write, grep, find, delegate | explorer, researcher | Implementation — the only role that can modify files |
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
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-subagent
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-subagent"
  ]
}
```

## Configuration

Edit `~/.pi/agent/settings.json`:

```json
{
  "subagent": {
    "timeout": 1500,
    "maxConcurrency": 4,
    "maxDepth": 3,
    "maxTurns": 0,
    "maxCost": 0,
    "history": {
      "enabled": true
    },
    "summary": {
      "role": "utility",
      "enabled": true
    }
  }
}
```

All fields are optional. Defaults: `timeout: 1500` (seconds; 25 min; active time — the clock pauses while the child is inside a nested `delegate` call, so delegate-capable roles need no extra headroom), `maxConcurrency: 4`, `maxDepth: 3`, `maxTurns: 0` (unlimited), `maxCost: 0` (unlimited), `history.enabled: true`, `summary.role: "utility"`, `summary.enabled: true`.

All numeric limits accept `0` for unlimited: `timeout`, `maxConcurrency`, `maxDepth`, `maxTurns`, and `maxCost`. Negative values are normalized to `0`; non-numeric or non-finite values fall back to their defaults. `maxConcurrency: 0` runs delegates without queuing, and `maxDepth: 0` permits unrestricted nesting.

### Agent Overrides

Override, disable, or add subagent roles via `agentOverrides`. Built-in and custom roles are treated equally — all descriptions, examples, and decision triggers feed into the LLM's prompt dynamically.

```json
{
  "subagent": {
    "agentOverrides": {
      "worker": {
        "role": "heavy",
        "timeout": 1500,
        "maxTurns": 50,
        "maxCost": 1.0
      },
      "reviewer": {
        "disabled": true
      },
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

**Optional fields:** `subagentRoles` (roles this role can spawn via delegate), `timeout` (per-role active-time timeout in seconds; unset uses the global setting, `0` is unlimited, negative values normalize to `0`), `maxTurns` / `maxCost` (per-role budget overrides; unset uses the global setting, `0` is unlimited, negative values normalize to `0`), `fallbackRole` (backup pi-model-roles role on provider errors).

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

### Passing context and reference files

pi-subagent delivers context to the child as **independent channels**, never fused into the task string. This keeps the task an unambiguous directive and lets each channel be sized independently.

#### `context` (inline text)

Hand the subagent precise context — selected code, a prior delegate's result, a file list, a git diff — without inflating the `task` string. It's delivered as a separate channel:

```json
{
  "role": "worker",
  "task": "Add input validation to the login function",
  "context": "Current implementation (src/auth.ts:42-70):\n```ts\nasync function login(email, pw) { ... }\n```\nValidation must reject empty/invalid emails and enforce a min 8-char password."
}
```

The stored/displayed task stays as the original `task`. When small, `context` inlines as a `<context>` block; when large (over 8,000 chars) it spills to a temp file injected via `@file`, so a large context never drags a short task into a spill.

#### `files` (reference paths)

```json
{
  "role": "explorer",
  "task": "Report the public API of the auth module",
  "files": ["src/auth.ts", "src/auth.types.ts"]
}
```

Each path is injected as an independent `@file` attachment the subagent reads directly. **File contents stay out of your context window** — you pass only the paths. Prefer this over pasting file contents into `context`, since the child receives the content on its first turn without spending a tool call to read it.

### Budget enforcement

`maxTurns` / `maxCost` cap a run. When exceeded, the child is killed and the last completed output is returned with `stopReason: "budget_exceeded"` (shown in the expanded TUI). Defaults are unlimited (`0`); set global defaults in config or per-role overrides in `agentOverrides`. Negative values are normalized to `0`.

### Oversized outputs

When a run's output exceeds the size limit (50,000 chars), pi-subagent first tries to **compress** it with the summary model (same role configured under `summary.role`) into a compact form that preserves conclusions, code, file paths, and errors. If compression fails or doesn't shrink enough, it falls back to mechanical head+tail truncation. The prepared text is what the main model receives and what the expanded TUI renders; a hint line notes which method was used. The **full raw output is always kept in the history file** for auditing.

### Run history

Every completed delegate run is written (best-effort) to `~/.pi/subagent/history/{sessionId}/{toolCallId}.json`, recording role, task, usage, activity log, and the **full raw output** (even when the main model saw a compressed/truncated version). Useful for auditing what subagents did and how much they cost. Disable with `history.enabled: false`.

## License

MIT
