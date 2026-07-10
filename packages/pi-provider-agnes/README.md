# @d3ara1n/pi-provider-agnes

Agnes AI provider for pi — registers two providers sharing the same text models but differing in billing model.

## Providers

| Provider ID | Name | Billing | API Key Env |
|---|---|---|---|
| `agnes` | Agnes AI | Token billing | `$AGNES_API_KEY` |
| `agnes-plan` | Agnes AI (Token Plan) | Subscription plan | `$AGNES_PLAN_API_KEY` |

### `agnes`

Token-based billing provider. Agnes has not published official token pricing, so cost values are 0 (no cost shown). Update when Agnes publishes pricing — use the non-discounted regular-period price (see [PROVIDER.md](../../PROVIDER.md)).

### `agnes-plan`

Subscription plan provider. Cost set to zero — the subscription fee is a fixed monthly charge, not per-token.

## Models

Both providers export the same text models:

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `agnes-2.0-flash` | Yes | text, image | 256K | 64K |
| `agnes-1.5-flash` | No | text, image | 256K | 64K |

## Installation

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

Not yet implemented. Agnes AI does not currently expose a public quota or balance API. When one becomes available, quota reporting will be added via `@d3ara1n/pi-usage-block-core`. See [`plans/pi-provider-agnes.md`](../../plans/pi-provider-agnes.md) for the integration plan.
