# @d3ara1n/pi-scout

Per-turn side agent decision framework for [pi](https://github.com/earendil-works/pi).

Before each conversation turn, a cheap side agent model analyzes the user's prompt and makes routing decisions:

1. **skill-router** — Selects which skills to activate and injects their full content (replacing pi's default skill metadata list)
2. **model-router** — Automatically switches the active model role based on task complexity

Both modules can be independently toggled on/off.

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

## Requirements

- **@d3ara1n/pi-model-roles** must be installed and configured
- A `side` role must be defined in `modelRoles` configuration

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
    "sideAgentRole": "side",
    "maxSelectedSkills": 5,
    "modules": {
      "skillRouter": true,
      "modelRouter": true
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Global on/off |
| `sideAgentRole` | `"side"` | pi-model-roles role for the side agent |
| `maxSelectedSkills` | `5` | Max skills the side agent can select |
| `modules.skillRouter` | `true` | Enable/disable skill routing |
| `modules.modelRouter` | `true` | Enable/disable model routing |

## Commands

| Command | Description |
|---------|-------------|
| `/scout` | Show scout status and last decision |
| `/scout skill-router on/off` | Toggle skill-router module |
| `/scout model-router on/off` | Toggle model-router module |

## Performance

Side agent adds ~0.5–2s latency per turn. Output is limited to 256 tokens.

## License

MIT
