# @d3ara1n/pi-provider-zhipu-coding-plan

Zhipu AI Coding Plan provider for [Pi Coding Agent](https://pi.dev) — auto-discovers models and reports usage quota.

## Features

- **Dynamic model discovery** — fetches available models from Zhipu's `/models` endpoint at startup
- **Fallback model list** — ships with known GLM model metadata when API is unreachable
- **Usage quota reporting** — displays token usage percentage and reset countdown in the status bar
- **No manual config** — reads API key from `~/.pi/agent/auth.json` (set via `/login`)

## Install

```bash
pi install npm:@d3ara1n/pi-provider-zhipu-coding-plan
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

Supported models include GLM-4.5 through GLM-5.1 series, with vision variants (suffix `v`). Model metadata (context window, max tokens, compatibility flags) is maintained in `KNOWN_MODELS` and updated alongside dynamic discovery.

## Usage Display

When paired with `@d3ara1n/pi-usage-block`, the status bar shows:

```
Zhipu Coding 🟢53% ↺3h34m
```

- **53%** — token quota consumed (from the TOKENS_LIMIT API)
- **3h34m** — time until quota resets
- 🟢/🟡/🔴 — green/yellow/red based on 70%/90% thresholds

Lite plan shows one window (5h). Pro plan may show two (5h + weekly).
