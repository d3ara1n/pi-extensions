# @d3ara1n/pi-provider-stepfun

StepFun (阶跃星辰) provider for pi — registers two providers covering both billing channels via StepFun's OpenAI-compatible API.

## Providers

| Provider ID | Channel | Base URL | API Key Env |
|---|---|---|---|
| `stepfun` | Pay-as-you-go | `api.stepfun.com/v1` | `STEP_API_KEY` |
| `stepfun-plan` | Step Plan subscription | `api.stepfun.com/step_plan/v1` | `STEP_PLAN_API_KEY` |

Both channels accept the same API key — set both env vars to it if you only have one. The difference is billing and model set:

- **`stepfun`** bills per token (CNY) and includes `step-1o-turbo-vision`.
- **`stepfun-plan`** bills against your Step Plan monthly credit and includes `step-router-v1`.

## Models

| Model | Reasoning | Input | Context | Max Output | Providers |
|---|---|---|---|---|---|
| `step-3.7-flash` | Yes | text, image | 256K | 16K | both |
| `step-3.5-flash` | Yes | text | 256K | 16K | both |
| `step-3.5-flash-2603` | Yes | text | 256K | 16K | both |
| `step-1o-turbo-vision` | No | text, image | 32K | 8K | `stepfun` |
| `step-router-v1` | Yes | text | 1M | 16K | `stepfun-plan` |

`step-3.5-flash-2603` is the Agent/Coding-optimized snapshot of `step-3.5-flash` — faster and more token-efficient, tuned for coding and agent frameworks.

### `step-router-v1`

A routing model: it automatically dispatches each request to either `deepseek-v4-pro` (complex reasoning, long agent chains, 1M context) or `step-3.5-flash` (fast, routine calls) based on task complexity, with no manual routing logic. Useful as a "one model that picks the right engine for the job" default.

Note that `step-router-v1` emits an `[Advisor consultation] … [End of advisor consultation]` planning block inside its text output — this is the router's internal planning, not something to act on.

## Pricing

StepFun bills in CNY per million tokens:

| Model | Input (cache miss) | Input (cache hit) | Output |
|---|---|---|---|
| `step-3.7-flash` | ¥1.35 | ¥0.27 | ¥8.1 |
| `step-3.5-flash` / `-2603` | ¥0.7 | ¥0.14 | ¥2.1 |
| `step-1o-turbo-vision` | ¥2.5 | ¥0.5 | ¥8 |
| `step-router-v1` | — | — | billed via Step Plan credit |

Cost estimation in pi's status bar is disabled (set to 0), since it assumes USD. Use the rates above to gauge spend on the pay-as-you-go channel.

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

## Dependencies

None — standalone provider with no pi-extension dependencies. It uses pi's built-in `openai-completions` streaming.
