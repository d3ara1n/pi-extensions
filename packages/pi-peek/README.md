# @d3ara1n/pi-peek

Core capability library for [pi](https://github.com/earendil-works/pi) — serialize the main conversation and answer questions about it via the utility model, read-after-burn.

**Pure library**: registers tracker hooks but **no tools, no commands**. It is consumed by [`pi-peek-user`](../pi-peek-user) (local `/peek` overlay) and [`pi-peek-agent`](../pi-peek-agent) (cross-instance mesh). Installing this alone does nothing user-visible.

## What it does

- **Serialize** the current main conversation branch into compact reference text (turns + tool calls, per-tool-result truncation)
- **Investigate**: stream a consult to the `utility` model role with the record as background context and the question as the standalone user message
- **Tracker**: live snapshot of the local main agent's activity (tool name, turn index), hook-driven
- **Read-after-burn**: nothing is persisted, no session file is touched, the main agent is never disturbed

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-peek
```

Both are extensions and must be loaded in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-peek"
  ]
}
```

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — resolves the `utility` model role

## Configuration

Optional tuning in `~/.pi/agent/settings.json` under `peek`:

```json
{
  "peek": {
    "recentTurns": 10,
    "toolResultLimit": 500,
    "role": "utility"
  }
}
```

`recentTurns` and `toolResultLimit` control serialization; invalid numeric values fall back to defaults. `role` selects the pi-model-roles role used for consults.

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
