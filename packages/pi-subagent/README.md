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
- **Collapsed result**: `✓ explorer · 找到了登录/注册/token三块逻辑` + recent tool calls + usage stats
- **Expanded result** (Ctrl+O): Full task text, all tool calls, final output as rendered Markdown, and usage details

## Requirements

- **@d3ara1n/pi-model-roles** must be installed and configured
- **@earendil-works/pi-tui** — bundled with pi, no separate install needed
- Role definitions must exist in `modelRoles` settings

## Installation

```bash
pi extension add @d3ara1n/pi-subagent
```

## Configuration

Edit `~/.pi/agent/settings.json`:

```jsonc
{
  "subagent": {
    // Default timeout per subagent (5 minutes)
    "timeoutMs": 300000,

    // Summary generation — uses a lightweight model to create
    // a one-line Chinese summary for the TUI display
    "summary": {
      "role": "utility",    // pi-model-roles role for summarization
      "enabled": true        // set false to disable
    }
  }
}
```

All fields are optional. Defaults: `timeoutMs: 300000`, `summary.role: "utility"`, `summary.enabled: true`.

## Usage (by the main model)

```json
{
  "role": "explorer",
  "task": "Find all files that import the ModelRegistry and trace how they use it"
}
```

## License

MIT
