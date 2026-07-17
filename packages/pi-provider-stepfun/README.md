# @d3ara1n/pi-provider-stepfun

StepFun (阶跃星辰) provider for pi — registers the Step 3.x Flash reasoning models via StepFun's OpenAI-compatible API.

## Models

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `step-3.7-flash` | Yes | text, image | 256K | 16K |
| `step-3.5-flash` | Yes | text | 256K | 16K |
| `step-3.5-flash-2603` | Yes | text | 256K | 16K |
| `step-1o-turbo-vision` | No | text, image | 32K | 8K |

`step-3.5-flash-2603` is the Agent/Coding-optimized snapshot of `step-3.5-flash` — faster and more token-efficient, tuned for coding and agent frameworks.

## Pricing

StepFun bills in CNY per million tokens:

| Model | Input (cache miss) | Input (cache hit) | Output |
|---|---|---|---|
| `step-3.7-flash` | ¥1.35 | ¥0.27 | ¥8.1 |
| `step-3.5-flash` / `-2603` | ¥0.7 | ¥0.14 | ¥2.1 |
| `step-1o-turbo-vision` | ¥2.5 | ¥0.5 | ¥8 |

Cost estimation in pi's status bar is disabled (set to 0), since it assumes USD. Use the rates above to gauge spend.

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

Get an API key from the [StepFun console](https://platform.stepfun.com), then set it via environment variable:

```bash
export STEP_API_KEY="your-api-key"
```

Or store it through `/login`, or manually in `~/.pi/agent/auth.json`:

```json
{ "stepfun": { "apiKey": "your-api-key" } }
```

## Notes

- **The Step 3.x Flash models always reason.** Turning thinking off in pi only omits the reasoning parameter — the model still thinks at its default level. This is a model characteristic, not something the provider can disable. `step-1o-turbo-vision` does not reason.

## Dependencies

None — standalone provider with no pi-extension dependencies. It uses pi's built-in `openai-completions` streaming.
