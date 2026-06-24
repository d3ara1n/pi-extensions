# @d3ara1n/pi-peek

Core capability library for [pi](https://github.com/earendil-works/pi) — serialize the main conversation and answer questions about it via the utility model, read-after-burn.

**Pure library**: registers tracker hooks but **no tools, no commands**. It is consumed by [`pi-peek-user`](../pi-peek-user) (local `/peek` overlay) and [`pi-peek-agent`](../pi-peek-agent) (cross-instance mesh). Installing this alone does nothing user-visible.

## What it does

- **Serialize** the current main conversation branch into compact reference text (turns + tool calls, truncated)
- **Investigate**: stream a consult to the `utility` model role with the record as background context and the question as the standalone user message
- **Tracker**: live snapshot of the local main agent's activity (tool name, turn index), hook-driven
- **Read-after-burn**: nothing is persisted, no session file is touched, the main agent is never disturbed

## Install

```bash
pi extension add @d3ara1n/pi-peek
```

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — resolves the `utility` model role

## Configuration

Optional tuning in `~/.pi/agent/settings.json` under `peek`:

```jsonc
{
  "peek": {
    "recentTurns": 10,        // keep the most recent N user-initiated turns
    "maxChars": 50000,        // hard cap on total serialized characters
    "toolResultLimit": 500    // truncate a single tool result longer than this
  }
}
```

## API (for extension authors)

```typescript
import { getPeekAPI } from "@d3ara1n/pi-peek";

const api = getPeekAPI();

// One-shot consult: serialize + stream to the utility model
const result = await api.investigate("How is debounce implemented here?", {
  onToken: (delta) => { /* stream chunks */ },
  onStage: (stage) => { /* "investigating" | "done" | "error" */ },
});
// result.answer / result.model / result.usage

// Current main-agent activity (driven by agent_start/tool_execution_*/turn_end hooks)
api.getMainAgentStatus();   // { activity, toolName, toolIndex, turn, lastUpdated }
```

`investigate()` is entry-point-agnostic (pure function over reference text + question): both the local overlay and the cross-instance IPC server call it directly.

## License

MIT
