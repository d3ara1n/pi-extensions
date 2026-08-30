# @d3ara1n/pi-scout

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-scout)](https://www.npmjs.com/package/@d3ara1n/pi-scout) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-scout)](https://www.npmjs.com/package/@d3ara1n/pi-scout) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-scout)](https://www.npmjs.com/package/@d3ara1n/pi-scout)

Every skill you install in pi gets advertised in the system prompt on every turn — the relevant ones and the irrelevant ones alike. As your skill collection grows, that list bloats the prompt, dilutes the main model's attention, and eats context.

Scout runs a cheap side model **before each turn** to look at what you just asked and decide what the main model actually needs this turn: which skills are relevant, whether the task calls for a heavier or lighter model. The main model then starts with a focused prompt instead of the full skill dump.

## What scout does

Three independent modules — toggle each one separately.

**Skill router** (on by default) — The side model picks the skills relevant to your prompt and replaces pi's full skill list with just those. Your main model sees a shorter, focused prompt: less context noise, a smaller prompt to cache, lower cost.

**Model router** (off by default) — Shifts the active model based on task complexity: a heavy model for a refactor, a fast one for a quick question. Off by default because it changes your model persistently — see [Why model-router is off by default](#why-model-router-is-off-by-default).

**Short-circuit** (on by default) — Skips the side model entirely on a trivial acknowledgment (`好的` / `ok` / `はい` / `네`). A bare "ok" never needs skill selection or a model switch, so paying the side-model round-trip is pure waste. The main model just replies.

## What you'll see

After you send a message, watch the status bar while scout runs:

- `◎ scout analyzing via deepseek/…` — the side model is reading your prompt (adds roughly 0.5–2s)
- `✓ scout: 3 skills` — the decision scout applied this turn (a `+ role` suffix appears when model-router recommends a switch)
- `✓ scout: (skipped) trivial ack` — short-circuit fired; the main model replies with no scout wait

If the side model's reply is malformed or times out, scout drops the decision and the main turn continues normally — scout never blocks your work.

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — model role resolution. Must be loaded alongside scout.

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
| `modules.modelRouter` | `false` | Enable/disable model routing — see [Why model-router is off by default](#why-model-router-is-off-by-default) |
| `modules.shortCircuit` | `true` | Enable/disable the short-circuit layer |
| `shortCircuit.trivialAck` | `true` | Enable the trivial-acknowledgment rule |
| `shortCircuit.maxAckLength` | `12` | Max prompt length (chars) for the trivial-ack rule |
| `shortCircuit.ackPhrases` | `[]` | Extra ack phrases merged on top of the built-in 中/英/日/韓 table |

## Commands and tools

| Command | Description |
|---------|-------------|
| `/scout` | Show scout status and last decision |
| `/scout:skill-router on/off` | Toggle skill-router module |
| `/scout:model-router on/off` | Toggle model-router module |
| `/scout:short-circuit on/off` | Toggle short-circuit module |

- `list_skills` — tool that lists every installed skill with name and description, including ones not selected for the current turn

---

## How it works

```
You send a prompt
      │
      ▼
Trivial ack? (好的 / ok / はい) ── yes ──► skip scout, main model replies at once
      │ no
      ▼
Side model reads: your prompt + installed skills + current model
      │
      ▼
Picks relevant skills · (optionally) recommends a different model
      │
      ▼
Main model runs — with only the selected skills, on the chosen model
```

A trivial acknowledgment is a short prompt that is *entirely* an ack — matched against a built-in 中/英/日/韓 phrase table. Long prompts are never treated as acks even if they begin with an ack word, so `好的，那我们重构整个模块` always reaches the side model.

## Limitations

Scout only runs when you send a prompt to an idle agent. Messages typed while the agent is already working — mid-run steering and queued follow-ups — are not scouted: they run with the skills and model already chosen for that run. If you steer into something unrelated to the current task, the new skills won't be picked until your next prompt from idle.

## Why model-router is off by default

Unlike the other two modules, model-router makes a **persistent** change: it switches pi's active model — the same kind of state change as selecting one manually — and subsequent turns stay on the routed model until something else changes it.

Frequent switching has a real cost: each model keeps its own prompt cache, so every switch re-uploads the system prompt and tool list and pays a fresh cache write. Across a session of back-and-forth switching that adds up in extra tokens and latency on the turn after each switch.

The other two modules are per-turn and cheap to undo, so they're on by default. Model-router is off unless you specifically want automatic model shifting and are willing to absorb the cache churn. Enable it per-session with `/scout:model-router on`, or persistently in settings:

```jsonc
{
  "scout": {
    "modules": { "modelRouter": true }
  }
}
```

## Performance

The side model adds roughly 0.5–2s to each turn it runs on (i.e. every non-short-circuited turn). That's the trade for a shorter, more focused main-model prompt. Short-circuit removes it entirely on trivial acks. The side model is asked for compact output; if its reply is malformed or oversized, scout discards the decision and the main turn proceeds unchanged — scout degrades gracefully and never blocks.

## License

MIT
