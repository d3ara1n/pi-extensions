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
    // Default timeout per subagent (5 minutes)
    "timeoutMs": 300000,

    // Summary generation — uses a lightweight model to create
    // a one-line summary for the TUI display
    "summary": {
      "role": "utility",    // pi-model-roles role for summarization
      "enabled": true        // set false to disable
    }
  }
}
```

All fields are optional. Defaults: `timeoutMs: 300000`, `summary.role: "utility"`, `summary.enabled: true`.

### Agent Overrides

Override, disable, or add subagent roles via `agentOverrides`. Built-in and custom roles are treated equally — all descriptions, examples, and decision triggers feed into the LLM's prompt dynamically.

```jsonc
{
  "subagent": {
    "agentOverrides": {
      // ── Override a built-in role (only specify changed fields) ──
      "worker": {
        "role": "heavy"               // use a stronger model
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

**Optional fields:** `subagentRoles` (roles this role can spawn via delegate), `fallbackRole` (backup pi-model-roles role on provider errors).

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

## License

MIT
