# @d3ara1n/pi-provider-agnes

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-provider-agnes)](https://www.npmjs.com/package/@d3ara1n/pi-provider-agnes) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-provider-agnes)](https://www.npmjs.com/package/@d3ara1n/pi-provider-agnes) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-provider-agnes)](https://www.npmjs.com/package/@d3ara1n/pi-provider-agnes)

Agnes AI provider for pi — registers two providers sharing the same text + image models but differing in billing model.

## Providers

| Provider ID | Name | Billing | API Key Env |
|---|---|---|---|
| `agnes` | Agnes AI | Token billing | `$AGNES_API_KEY` |
| `agnes-plan` | Agnes AI (Token Plan) | Subscription plan | `$AGNES_PLAN_API_KEY` |

### `agnes`

Token-based billing provider. Agnes has not published official token pricing, so pi shows no cost estimates for these models.

### `agnes-plan`

Subscription plan provider. Cost set to zero — the subscription fee is a fixed monthly charge, not per-token.

## Models

Both providers export the same chat model list, **refreshed from the
live API** (`GET /v1/models`) when the cached snapshot is stale — at most
once every 4 hours, matching pi's built-in catalog cadence. `pi update
--models` forces an immediate refresh; the last-seen catalog is restored
on offline startups. The endpoint returns ids only, so context windows,
modalities and thinking behavior fall back to the shipped specs per model
id; models new to the catalog get family defaults (text+image input,
Qwen-style thinking toggle). Image-generation (`agnes-image-*`) and
video-generation (`agnes-video-*`) models are excluded automatically.

Shipped chat specs (verified against the live catalog 2026-10-10):

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `agnes-2.5-flash` | Yes | text, image | 512K | 65.5K |
| `agnes-2.0-flash` | Yes | text, image | 256K | 64K |
| `agnes-2.5-pro` / `-beta` / `-alpha` | Yes | text, image | 256K* | 64K* |
| `agnes-3.0-flash` / `-flash-max` | Yes | text, image | 256K* | 64K* |

\* endpoint publishes no metadata — family defaults, pending a live check.
`agnes-1.5-flash` is no longer listed by the live catalog and was
removed (2026-10); it re-registers automatically if it returns.

```bash
pi install npm:@d3ara1n/pi-provider-agnes
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-provider-agnes"
  ]
}
```

Set your API key(s) via environment variable:

```bash
export AGNES_API_KEY="sk-..."       # for agnes provider
export AGNES_PLAN_API_KEY="sk-..."  # for agnes-plan provider
```

Or configure via `/login` or `auth.json`.

## Dependencies

None — this is a standalone provider with no pi-extension dependencies. It uses pi's built-in `openai-completions` streaming.

## Usage Quota Reporting

Not yet implemented — Agnes AI does not currently expose a public quota or balance API. When one becomes available, quota reporting will be added via `@d3ara1n/pi-usage-block-core`.
