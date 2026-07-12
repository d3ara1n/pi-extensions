# @d3ara1n/pi-provider-zhipu-coding-plan

Zhipu AI Coding Plan provider for [Pi Coding Agent](https://pi.dev) — ships a static GLM model list and reports usage quota.

## Features

- **Usage quota reporting** — displays token usage percentage and reset countdown in the status bar
- **No manual config** — reads API key from `~/.pi/agent/auth.json` (set via `/login`)

## Dependencies

- [`@d3ara1n/pi-usage-block-core`](../pi-usage-block-core) — registers the Zhipu quota provider

## Installation

```bash
pi install npm:@d3ara1n/pi-usage-block-core
pi install npm:@d3ara1n/pi-provider-zhipu-coding-plan
```

Or add the provider extension to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-provider-zhipu-coding-plan"
  ]
}
```

Also install the status bar display if you want quota visibility:

```bash
pi install npm:@d3ara1n/pi-usage-block
```

## Setup

Use `/login` in Pi and select the **zhipu-coding** provider to store your API key.

Or manually add to `~/.pi/agent/auth.json`:

```json
{ "zhipu-coding": { "apiKey": "your-key-here" } }
```

## Models

Supported models span the GLM-4.5 through GLM-5.2 series (text only). Model metadata (context window, max tokens, compatibility flags) is maintained statically in `KNOWN_MODELS`.

## Compatibility Notes

The current provider configuration uses pi's built-in `openai-completions` transport and static compat flags maintained in `KNOWN_MODELS`. Before changing model metadata or compat flags, re-run the provider checks in [`PROVIDER.md`](../../PROVIDER.md): thinking format, system/developer role, tool-call stream shape, usage reporting, max-token field, and context-overflow error text.

## Usage Display

When paired with `@d3ara1n/pi-usage-block`, the status bar shows:

```
Zhipu Coding 🟢53% ↺3h34m
```

- **53%** — token quota consumed (from the TOKENS_LIMIT API)
- **3h34m** — time until quota resets
- 🟢/🟡/🔴 — green/yellow/red based on 70%/90% thresholds

Lite plan shows one window (5h). Pro plan may show two (5h + weekly).
