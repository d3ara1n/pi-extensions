# @d3ara1n/pi-provider-agnes

Agnes AI provider for pi — registers two providers sharing the same text models but differing in billing model.

## Providers

| Provider ID | Name | Billing | API Key Env |
|---|---|---|---|
| `agnes` | Agnes AI | Token billing (placeholder) | `$AGNES_API_KEY` |
| `agnes-plan` | Agnes AI (Token Plan) | Subscription plan | `$AGNES_PLAN_API_KEY` |

### `agnes`

Token-based billing provider. Cost values use Agnes AI's legacy per-token pricing ($0.03/1M input, $0.15/1M output) as placeholders — Agnes has not yet published official token pricing. Update when they do.

### `agnes-plan`

Subscription plan provider. Cost set to zero — the subscription fee is a fixed monthly charge, not per-token.

## Models

Both providers export the same text models:

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `agnes-2.0-flash` | Yes | text, image | 256K | 64K |
| `agnes-1.5-flash` | No | text, image | 256K | 64K |

## Installation

Add the extension path to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/path/to/pi-extensions/packages/pi-provider-agnes"
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

Not yet implemented. Agnes AI does not currently expose a public quota or balance API. When one becomes available, quota reporting will be added via `@d3ara1n/pi-usage-block-core`. See [`plans/pi-provider-agnes.md`](../../plans/pi-provider-agnes.md) for the integration plan.
