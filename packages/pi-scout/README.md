# @d3ara1n/pi-scout

Per-turn side agent decision framework for [pi](https://github.com/earendil-works/pi).

Before each conversation turn, scout analyzes the user's prompt and makes routing decisions:

1. **skill-router** — Selects which skills to advertise to the main model and replaces pi's full skill list with a compact selected-skill list
2. **model-router** — Switches the active model role based on task complexity
3. **short-circuit** — Skips the side model entirely on trivial acknowledgments (`好的` / `ok` / `はい`), avoiding the per-turn latency and cost

All three modules can be independently toggled on/off.

## Why model-router is disabled by default

Model-router switches the active model role based on task complexity. This is a persistent pi model change, the same kind of state change as selecting a model manually, so subsequent turns continue on the routed model until something changes it again.

This can:

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

## Short-circuit layer

Short-circuit is a cost/latency optimization that lets scout **skip the side model entirely** on trivial acknowledgments. It mirrors OpenHuman's hybrid-gate pattern: cheap signals handle the obvious cases, the side model only handles the ambiguous middle — so there is no quality loss.

**Trivial acknowledgment** — a short prompt that is *entirely* an ack (`好的` / `ok` / `はい` / `네`) routes to "no skills, no role change". Matched against a built-in 中/英/日/韓 phrase table. A trivial ack settles every module, so this is safe even with model-router on. Long prompts are never treated as acks even if they start with an ack word, so `好的，那我们重构整个模块` always reaches the side model.

Anything that isn't a trivial ack falls through to the side model — that's what the model is for. When short-circuit fires, the status bar shows `✓ scout: (skipped) trivial ack` for transparency.

## How it works

```
User sends prompt
    │
    ▼
before_agent_start hook fires
    │
    ├─ [short-circuit] Trivial ack? → decide instantly, skip the side model
    │     (status shows "✓ scout: (skipped) …")
    │
    ├─ otherwise → Side agent (cheap model) analyzes prompt + available skills + current role
    ├─ Returns: { skills: [...], role: "...", reasoning: "..." }
    │
    ├─ [skill-router] Replaces pi's full skill list with selected skill metadata
    │     (the main model can then read the selected skill file when needed)
    └─ [model-router] Switches the active model if a different role is recommended
```

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — model role resolution

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-scout
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-scout"
  ]
}
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
      "modelRouter": false,
      "shortCircuit": true
    },
    "shortCircuit": {
      "trivialAck": true,
      "maxAckLength": 12,
      "ackPhrases": ["收到啦", "will do"]
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Global on/off |
| `sideAgentRole` | `"utility"` | pi-model-roles role for the side agent |
| `maxSelectedSkills` | `5` | Max skills the side agent can select; `0` means unlimited. Negative values are normalized to `0` |
| `modules.skillRouter` | `true` | Enable/disable skill routing |
| `modules.modelRouter` | `false` | Enable/disable model routing (disabled by default to avoid cache inefficiency and extra costs) |
| `modules.shortCircuit` | `true` | Enable/disable the short-circuit layer |
| `shortCircuit.trivialAck` | `true` | Enable the trivial-acknowledgment rule |
| `shortCircuit.maxAckLength` | `12` | Max prompt length (chars) for the trivial-ack rule |
| `shortCircuit.ackPhrases` | `[]` | Extra ack phrases merged on top of the built-in 中/英/日/韓 table |

## Commands

| Command | Description |
|---------|-------------|
| `/scout` | Show scout status and last decision |
| `/scout:skill-router on/off` | Toggle skill-router module |
| `/scout:model-router on/off` | Toggle model-router module |
| `/scout:short-circuit on/off` | Toggle short-circuit module |

## Performance

Side agent adds ~0.5–2s latency per non-short-circuited turn. The prompt asks the side agent for compact JSON, but the current implementation does not enforce a hard output-token cap; malformed or oversized output is rejected and the main turn continues without applying that decision.

## License

MIT
