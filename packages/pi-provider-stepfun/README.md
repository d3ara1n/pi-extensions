# @d3ara1n/pi-provider-stepfun

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-provider-stepfun)](https://www.npmjs.com/package/@d3ara1n/pi-provider-stepfun) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-provider-stepfun)](https://www.npmjs.com/package/@d3ara1n/pi-provider-stepfun) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-provider-stepfun)](https://www.npmjs.com/package/@d3ara1n/pi-provider-stepfun)

StepFun (阶跃星辰) provider for pi — registers pay-as-you-go and Step Plan channels through StepFun's Chat Completions API.

## Providers

| Provider ID | Channel | Base URL | API Key Env |
|---|---|---|---|
| `stepfun` | Pay-as-you-go | `api.stepfun.com/v1` | `STEP_API_KEY` |
| `stepfun-plan` | Step Plan subscription (Token Plan or legacy Coding Plan) | `api.stepfun.com/step_plan/v1` | `STEP_PLAN_API_KEY` |

Both channels accept the same API key — set both env vars to it if you only have one. The difference is billing and model set:

- **`stepfun`** bills per token (CNY) and includes `step-1o-turbo-vision`.
- **`stepfun-plan`** consumes Step Plan subscription allowance and includes `step-router-v1`.

StepFun also supports Anthropic-compatible Messages, but this extension uses its documented Chat Completions API for both channels. The base URLs above are not interchangeable: calling the ordinary API does not spend Step Plan allowance.

## Models

| Model | Reasoning | Input | Context | Max Output | Providers |
|---|---|---|---|---|---|
| `step-5-preview` | Yes | text, image | 1M | 64K | both |
| `step-3.7-flash` | Yes | text, image | 256K | 16K | both |
| `step-3.5-flash` | Yes | text | 256K | 16K | both |
| `step-3.5-flash-2603` | Yes | text | 256K | 16K | both |
| `step-1o-turbo-vision` | No | text, image | 32K | 8K | `stepfun` |
| `step-router-v1` | Yes | text | 1M | 16K | `stepfun-plan` |

`step-3.5-flash-2603` is the Agent/Coding-optimized snapshot of `step-3.5-flash` — faster and more token-efficient, tuned for coding and agent frameworks.

Step 5 Preview also accepts video through the API, but pi's model input declaration only supports text and images. StepFun documents up to 1M output tokens for this model; this extension caps individual responses at 64K so pi can reserve room for input within the 1M context. Its Chat Completions compatibility is based on the [published model documentation](https://platform.stepfun.com/docs/zh/guides/models/step-5-preview), not yet verified with a live API request.

### `step-router-v1`

A routing model: it automatically dispatches each request to either `deepseek-v4-pro` (complex reasoning, 1M context) or `step-3.7-flash` (routine calls, 256K context). pi advertises the router's larger context, but the selected engine's actual limit applies; very long requests may fail if routed to Flash. Charges depend on the engine selected for each request.

Note that `step-router-v1` emits an `[Advisor consultation] … [End of advisor consultation]` planning block inside its text output — this is the router's internal planning, not something to act on.

## Pay-as-you-go Pricing

The ordinary API bills in CNY per million tokens, using any gift balance before the topped-up account balance. Current [official rates](https://platform.stepfun.com/docs/zh/guides/pricing/details):

| Model | Input (cache miss) | Input (cache hit) | Output |
|---|---|---|---|
| `step-5-preview` | ¥7 | ¥0.35 | ¥20 |
| `step-3.7-flash` | ¥1.35 | ¥0.27 | ¥8.1 |
| `step-3.5-flash` / `-2603` | ¥0.7 | ¥0.14 | ¥2.1 |
| `step-1o-turbo-vision` | ¥2.5 | ¥0.5 | ¥8 |

Cost estimation in pi's status bar is disabled (set to 0), since it assumes USD. These prices are references, not amounts charged by the extension.

## Step Plan Subscription

Step Plan's current **Token Plan** measures model use in Credits (1M Credits = ¥1 of model usage). Credits are issued monthly, can be spent at any time during the month, and do not roll over. The plan channel does not draw on the ordinary API account balance.

| Tier | Credits per month | Monthly | Quarterly | Annually |
|---|---:|---:|---:|---:|
| Flash Mini | 400M | ¥49 | ¥129 | ¥456 |
| Flash Plus | 1,600M | ¥99 | ¥269 | ¥936 |
| Flash Pro | 8,000M | ¥199 | ¥539 | ¥1,860 |
| Flash Max | 40,000M | ¥699 | ¥1,889 | ¥6,666 |

Quarterly and annual plans are paid up front, but Credits are still issued monthly. Subscribers can buy a separate 30-day booster when their monthly allowance runs out: ¥49 for 400M Credits or ¥99 for 1,600M Credits. Model usage is converted to Credits from its actual API charges; `step-router-v1` uses the price of the engine selected for each request. These are the [published domestic tiers](https://platform.stepfun.com/docs/zh/step-plan/overview); check the subscription page for current prices in your region.

The older **Coding Plan** used request counts and five-hour/weekly limits. It cannot be purchased again, but existing subscribers with successful auto-renewal can keep it; upgrading to Token Plan is irreversible. Neither plan requires a different endpoint or provider ID. See the [official upgrade notice](https://platform.stepfun.com/docs/zh/step-plan/upgrade-notice).

## Installation

```bash
pi install npm:@d3ara1n/pi-provider-stepfun
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-provider-stepfun"
  ]
}
```

## Configuration

Get an API key from the [StepFun console](https://platform.stepfun.com), then set the env var for the channel(s) you use:

```bash
export STEP_API_KEY="your-api-key"        # stepfun (pay-as-you-go)
export STEP_PLAN_API_KEY="your-api-key"   # stepfun-plan (Step Plan)
```

Or store it through `/login`, or manually in `~/.pi/agent/auth.json`:

```json
{
  "stepfun": { "apiKey": "your-api-key" },
  "stepfun-plan": { "apiKey": "your-api-key" }
}
```

## Notes

- **The Step 3.x Flash models always reason.** Turning thinking off in pi only omits the reasoning parameter — the model still thinks at its default level. This is a model characteristic, not something the provider can disable. `step-1o-turbo-vision` does not reason.
- `step-3.5-flash-2603` accepts only `low` and `high` reasoning effort; pi's `medium` is mapped to `low`. For models with three documented effort levels, pi's extra levels are mapped into the `low`/`medium`/`high` range.

## Dependencies

None — standalone provider with no pi-extension dependencies. It uses pi's built-in `openai-completions` streaming.
