# @d3ara1n/pi-subagent

Role-based subagent orchestration for [pi](https://github.com/earendil-works/pi).

Provides a `delegate` tool that lets the main model delegate tasks to specialized pi child processes with configurable model roles, real-time TUI progress, and AI-generated summaries.

## How it works

1. Main model calls the `delegate` tool with a role and task description
2. The extension resolves the role to a model via pi-model-roles
3. Spawns an isolated pi child process with the configured model, tools, and system prompt
4. **Real-time TUI progress** shows tool calls, turns, and elapsed time as the subagent runs
5. After completion, an **AI-generated one-line summary** is produced for compact display
6. Returns the result to the main model with usage statistics (turns, tokens, cost)

## Built-in Roles

| Role | Model Role | Tools | Description |
|------|-----------|-------|-------------|
| `explorer` | fast | read, bash, find, grep, glob | Fast code search (read-only) |
| `reviewer` | heavy | read, bash, grep, glob | Deep code review (read-only) |
| `worker` | default | read, bash, edit, write, grep, glob | Implementation with file editing |
| `researcher` | fast | web_search, fetch_content, read | Web research and docs lookup |

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
