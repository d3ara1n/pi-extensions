# @d3ara1n/pi-provider-sensenova

SenseNova (商汤日日新) provider for [Pi Coding Agent](https://pi.dev) — registers the SenseNova Token Plan models via OpenAI-compatible API.

## Provider

| Provider ID | Name | API Key Env |
|---|---|---|
| `sensenova-plan` | SenseNova (Token Plan) | `$SENSENOVA_API_KEY` |

## Models

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `sensenova-6.7-flash-lite` | Yes | text, image | 256K | 64K |

`sensenova-6.7-flash-lite` is SenseTime's lightweight multimodal agent model for real-world workflows. This provider registers the model with:

- **Text + image input**
- **Reasoning enabled** in pi's model metadata
- **OpenAI-compatible chat/completions transport** via pi's built-in provider layer
- **`system` role compatibility** (`supportsDeveloperRole: false`)

Other compatibility details such as tool-call streaming quirks, usage chunks, and overflow error text should be re-verified against the live API before changing compat flags; see [`PROVIDER.md`](../../PROVIDER.md).

## Installation

```bash
pi install npm:@d3ara1n/pi-provider-sensenova
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-provider-sensenova"
  ]
}
```

Set your API key:

```bash
export SENSENOVA_API_KEY="sk-..."
```

Or use `/login` in pi to store it in `~/.pi/agent/auth.json`:

```json
{ "sensenova-plan": { "apiKey": "sk-..." } }
```

## Getting an API Key

1. Visit [SenseNova Platform](https://platform.sensenova.cn/console)
2. Go to 管理中心 → API-Key 管理 → 创建 API-Key
3. Copy the key immediately (it's shown only once)

The Token Plan is currently in **free public beta** — no credit card required, up to 1,500 calls per model every 5 hours, with up to 20 API keys.

## Dependencies

None — this is a standalone provider with no pi-extension dependencies. It uses pi's built-in `openai-completions` streaming.

## Usage Quota Reporting

Not yet implemented. SenseNova does not currently expose a public quota or balance API. When one becomes available, quota reporting will be added via `@d3ara1n/pi-usage-block-core`.
