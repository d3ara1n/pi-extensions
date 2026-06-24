# @d3ara1n/pi-scout

Per-turn side agent decision framework for [pi](https://github.com/earendil-works/pi).

Before each conversation turn, a cheap side agent model analyzes the user's prompt and makes routing decisions:

1. **skill-router** — Selects which skills to activate and injects their full content (replacing pi's default skill metadata list)
2. **model-router** — Automatically switches the active model role based on task complexity

Both modules can be independently toggled on/off.

## Why model-router is disabled by default

Model-router switches the active model role based on task complexity, which can:

- **Break prompt caching**: Different models don't share cache, causing cache write costs on each switch
- **Increase API costs**: Frequent model switching adds ~118% overhead in typical workloads
- **Reduce performance**: Cache misses mean re-uploading system prompt and tools each time

We recommend keeping model-router disabled unless you specifically need it. Enable it via:

```bash
/scout:model-router on        # Temporary (current session)
```

Or add to `settings.json` for persistent enablement:

```jsonc
{
  "scout": {
    "modules": {
      "modelRouter": true
    }
  }
}
```

## How it works

```
User sends prompt
    │
    ▼
before_agent_start hook fires
    │
    ├─ Side agent (cheap model) analyzes prompt + available skills + current role
    ├─ Returns: { skills: [...], role: "...", reasoning: "..." }
    │
    ├─ [skill-router] Strips <available_skills> XML, injects selected skill SKILL.md content
    └─ [model-router] Switches model if a different role is recommended
```

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — model role resolution

## Installation

```bash
pi extension add @d3ara1n/pi-scout
```

## Configuration

Edit `~/.pi/agent/settings.json`:

```jsonc
{
  "scout": {
    "enabled": true,
    "sideAgentRole": "fast",
    "maxSelectedSkills": 5,
    "modules": {
      "skillRouter": true,
      "modelRouter": false
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Global on/off |
| `sideAgentRole` | `"utility"` | pi-model-roles role for the side agent |
| `maxSelectedSkills` | `5` | Max skills the side agent can select |
| `modules.skillRouter` | `true` | Enable/disable skill routing |
| `modules.modelRouter` | `false` | Enable/disable model routing (disabled by default to avoid cache inefficiency and extra costs) |

## Commands

| Command | Description |
|---------|-------------|
| `/scout` | Show scout status and last decision |
| `/scout:skill-router on/off` | Toggle skill-router module |
| `/scout:model-router on/off` | Toggle model-router module |

## Performance

Side agent adds ~0.5–2s latency per turn. Output is limited to 256 tokens.

## License

MIT
