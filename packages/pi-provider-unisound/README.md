# @d3ara1n/pi-provider-unisound

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-provider-unisound)](https://www.npmjs.com/package/@d3ara1n/pi-provider-unisound) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-provider-unisound)](https://www.npmjs.com/package/@d3ara1n/pi-provider-unisound) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-provider-unisound)](https://www.npmjs.com/package/@d3ara1n/pi-provider-unisound)

Unisound (云知声) MaaS provider for [Pi Coding Agent](https://pi.dev) — registers the U2 model family (plus plan-hosted GLM/Kimi) via the platform's OpenAI-compatible API.

## Providers

| Provider ID | Name | Billing | API Key Env |
|---|---|---|---|
| `unisound` | Unisound MaaS | Pay-as-you-go | `$UNISOUND_API_KEY` |
| `unisound-plan` | Unisound MaaS (Token Plan) | Subscription | `$UNISOUND_PLAN_API_KEY` |

Both channels share the endpoint `https://maas-api.unisound.com/v1`. The keys are **not interchangeable**: pay-as-you-go keys come from *Metered & Packs → API Key Management*, Token Plan keys from *Subscription Management*.

> **Token Plan usage restriction**: plan quota may only be used inside coding tools (U2Claw, OpenClaw, OpenCode and equivalents like pi). Using the plan key for non-coding automation or application backends is considered abuse and may get the key blocked.

## Models

### `unisound` (pay-as-you-go)

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `u2-flash` | Yes (on/off, no effort levels) | text | 512K | 128K |
| `u2` | Always on (cannot disable) | text | 160K | 64K |
| `u2-med` | Yes (off / low / medium / high) | text, image | 256K | not documented — declared as 64K |
| `u2-radimed` | No (cannot enable) | text, image | 40K | not documented — declared as 8K |

### `unisound-plan` (Token Plan)

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `u2-flash` | Yes (on/off) | text | 512K | 128K |
| `u2` | Always on | text | 160K | 64K |
| `u2-med` | Yes (off / low / medium / high) | text, image | 256K | not documented — declared as 64K |
| `glm-5.2` | Yes (`reasoning_effort` off/high/max) | text | 1M | 128K |
| `kimi-k3` | Always on (`reasoning_effort` low/high/max) | text, image | 1M | 1M |

`u2-radimed` is not part of the Token Plan. The platform also hosts third-party models on pay-as-you-go (DeepSeek, Kimi, GLM, Qwen, MiniMax); they are intentionally not registered — use their native providers.

## Compatibility

- **Thinking** is on by default on the U2 models: `u2-flash` and `u2-med` can toggle it, `u2` always reasons, and `u2-radimed` never does. `u2-flash` ignores `reasoning_effort` (re-verified live), so only on/off is offered for it.
- **Reasoning effort** applies to `u2-med` and the plan-hosted models: `u2-med` exposes off / low / medium / high, `glm-5.2` exposes off / high / max, and `kimi-k3` is always-on with low / high / max. Gateway alias levels (e.g. `minimal` → `low` on `u2-med`) are hidden.
- **Image input**: `u2-flash` is text-only; `u2-med` and `u2-radimed` accept images.
- **Context overflow** errors match pi's built-in patterns, so auto-compaction works. Declared context windows are conservative, so pi compacts before the gateway rejects an oversized request.
- **Caching**: the API reports cache-hit tokens, which pi shows as cache-read tokens in the cost estimate.
- Tool calls, streaming, and usage reporting follow the standard OpenAI shapes.

## Pricing

pi tracks cost in USD. Unisound lists CNY prices, so `cost` fields are FX-converted estimates (~7.1 CNY/USD) for pi's status-bar display only — not real billing. List prices (input / cache-hit / output, CNY per million tokens): `u2-flash` 1/0.2/2 (limited-time promos such as the Sept–Oct 2026 free month excluded), `u2` 1/0.02/2, `u2-med` 8/2/28, `u2-radimed` 15/4/20. Token Plan models have subscription billing → `cost` 0. Cache-write pricing is not published.

## Installation

```bash
pi install npm:@d3ara1n/pi-provider-unisound
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-provider-unisound"
  ]
}
```

Set your API key (pay-as-you-go):

```bash
export UNISOUND_API_KEY="sk-..."
```

Or for the Token Plan:

```bash
export UNISOUND_PLAN_API_KEY="sk-..."
```

Or use `/login` in pi to store them in `~/.pi/agent/auth.json`:

```json
{
  "unisound": { "apiKey": "sk-..." },
  "unisound-plan": { "apiKey": "sk-..." }
}
```

Then switch models with `/model unisound/u2-flash` or `/model unisound-plan/kimi-k3`.

## Getting an API Key

1. Visit the [Unisound MaaS platform](https://maas.unisound.com)
2. Pay-as-you-go: Metered & Packs → API Key Management
3. Token Plan: subscribe on the [Token Plan](https://maas.unisound.com/token-plan) page, then Subscription Management → dedicated API key

Note that model access is scoped per key — a key without permission for a model returns `no model <id> permission`.

## Dependencies

None — this is a standalone provider with no pi-extension dependencies. It uses pi's built-in `openai-completions` streaming.

## Usage Quota Reporting

Not yet implemented — Unisound MaaS does not currently expose a public quota or balance API. Token Plan credits are visible only in the web console (Subscription Management). When one becomes available, quota reporting will be added via `@d3ara1n/pi-usage-block-core`.
