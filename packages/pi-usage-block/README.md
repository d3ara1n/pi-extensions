# @d3ara1n/pi-usage-block

Usage quota status bar block for [Pi Coding Agent](https://pi.dev) — displays quota for the **currently active** pi provider in the powerline.

Only shows usage when the active model's provider has a matching usage provider registered. Switching models automatically updates the display.

## Dependencies

None.

## Installation

```bash
pi install npm:@d3ara1n/pi-usage-block
```

Requires at least one usage provider plugin (e.g. `@d3ara1n/pi-provider-zhipu-coding-plan`).

## Configuration

### Powerline item

Add to your `settings.json` under `powerline.customItems`:

```json
{
  "powerline": {
    "customItems": [{
      "id": "usage",
      "statusKey": "usage-block",
      "position": "right",
      "prefix": "⚡",
      "color": "accent"
    }]
  }
}
```

### Refresh interval (api-source providers only)

Optionally set the poll interval (default: 60 seconds):

```json
{
  "usageBlock": {
    "refreshIntervalMs": 30000
  }
}
```

## Display format

```
ProviderName 🟢53% ↺3h34m
```

| Part | Meaning |
|------|---------|
| 🟢/🟡/🔴 | Usage threshold: < 70% / 70–90% / ≥ 90% |
| `53%` | Quota consumed |
| `↺3h34m` | Time until reset (only if provider supplies `resetAt`) |

Multiple quota windows from the same provider are shown side by side.

## How it works

1. Tracks the active provider via `ctx.model.provider` (from `session_start` and `model_select` events)
2. Looks up a registered `UsageProvider` whose `id` matches the active provider key
3. Queries usage based on the provider's `source` type:
   - **api**: timer-based polling via `fetchUsage()`
   - **headers**: event-driven via `after_provider_response` + `headerMapping`
4. If no matching usage provider exists, the status bar is cleared

## `/usage` command

The `/usage` slash command shows quota for **all** registered usage providers in one view.

- **api-source** providers: calls `fetchUsage()` on demand (5-second timeout per provider)
- **headers-source** providers: shows the last known value from API response headers, or `—` if no data is available yet

The active provider is marked with `*(active)*`.

```
**Usage — all providers**

Zhipu Coding Plan *(active)* (api)   🟢 43% ↺3h34m
OpenAI (api)                          🔴 89% ↺1h
Anthropic (headers)                   —
```

---

## Building a Usage Provider

A usage provider is a plugin that registers itself with the shared `usageRegistry` from `@d3ara1n/pi-usage-block-core`.

**This package is an npm dependency, not a pi extension.** Add it to your provider plugin's `package.json`:

```json
{
  "dependencies": {
    "@d3ara1n/pi-usage-block-core": "^1.0.0"
  }
}
```

### Key convention

The usage provider's `id` **must match** the pi provider key (the first argument to `pi.registerProvider()`):

```ts
// pi provider registration — this key is the shared identity
pi.registerProvider("zhipu-coding", { ... });

// usage provider registration — same key
usageRegistry.register({ id: "zhipu-coding", ... });
```

This is how `pi-usage-block` knows which usage data belongs to the active provider.

### Two data source types

#### api — Poll an external quota API

For providers whose usage quota lives behind a separate API endpoint (e.g. Zhipu, which doesn't include quota in response headers). `pi-usage-block` calls `fetchUsage()` on a timer.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-provider", {
    name: "My Provider",
    baseUrl: "https://api.example.com/v1",
    apiKey: "$MY_API_KEY",
    api: "openai-completions",
    models: [ ... ],
  });

  usageRegistry.register({
    id: "my-provider",           // must match pi.registerProvider key
    name: "My Provider",
    source: "api",
    async fetchUsage() {
      // Call your provider's quota API
      const res = await fetch("https://api.example.com/quota", {
        headers: { Authorization: `Bearer ${process.env.MY_API_KEY}` },
      });
      const data = await res.json();

      // Return one UsageWindow per quota window
      return [{
        period: "5h",
        used: data.percentage,     // amount consumed
        limit: 100,                // set to 100 if used is already a percentage
        unit: "tokens",
        resetAt: data.resetsAt     // optional Date
      }];
    },
  });
}
```

#### headers — Read usage from response headers

For providers that include rate-limit / usage info in HTTP response headers (e.g. OpenAI-style `x-ratelimit-*` headers). **No code needed** — just declare the mapping. `pi-usage-block` extracts data from each `after_provider_response` event automatically.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("openai-compatible", {
    name: "OpenAI Compatible",
    baseUrl: "https://api.example.com/v1",
    apiKey: "$MY_API_KEY",
    api: "openai-completions",
    models: [ ... ],
  });

  usageRegistry.register({
    id: "openai-compatible",      // must match pi.registerProvider key
    name: "My Provider",
    source: "headers",
    headerMapping: {
      // header name          → UsageWindow field
      "x-ratelimit-remaining-tokens": "used",
      "x-ratelimit-limit-tokens":     "limit",
      "x-ratelimit-reset-requests":   "resetAt",
    },
  });
}
```

Supported field keys in `headerMapping`:

| Key | Parsed as |
|-----|-----------|
| `"used"` | Number |
| `"limit"` | Number |
| `"period"` | Free-text label (string) |
| `"unit"` | `"requests"` \| `"tokens"` \| `"dollars"` |
| `"resetAt"` | Epoch seconds or milliseconds (auto-detected) |

Header lookup is case-insensitive.

### UsageWindow fields

```ts
interface UsageWindow {
  period: string;                     // Label, e.g. "5h", "daily"
  used: number;                       // Amount consumed (or percentage if limit=100)
  limit: number;                      // Maximum (use 100 for percentage-only)
  unit: "requests" | "tokens" | "dollars";
  resetAt?: Date;                     // When quota resets
}
```

Return an empty array `[]` from `fetchUsage()` when data is unavailable (the provider is treated as offline).

---

## Full API: @d3ara1n/pi-usage-block-core

```ts
import { usageRegistry, parseHeaderUsage } from "@d3ara1n/pi-usage-block-core";

// Register a provider
usageRegistry.register(provider: UsageProvider): void;

// Unregister
usageRegistry.unregister(id: string): void;

// Get a specific provider by id
usageRegistry.get(id: string): UsageProvider | undefined;

// Get all registered providers
usageRegistry.getAll(): UsageProvider[];
```

See [`@d3ara1n/pi-usage-block-core`](../pi-usage-block-core) for the full type definitions.
