# @d3ara1n/pi-usage-block

Usage status bar block for [Pi Coding Agent](https://pi.dev) — displays usage for the **currently active** pi provider in the [powerline-footer](https://pi.dev/packages/pi-powerline-footer) custom items system.

Supports two provider kinds (see [`@d3ara1n/pi-usage-block-core`](../pi-usage-block-core)):

- **quota** — consumed/limit per time window → percentage + countdown
- **balance** — absolute prepaid amount → amount, coloured by thresholds

Only shows usage when the active model's provider has a matching usage provider registered. Switching models automatically updates the display.

## Dependencies

- [`@d3ara1n/pi-editor-shell`](../pi-editor-shell) — optional, for editor shell pinned status integration

## Installation

```bash
pi install npm:@d3ara1n/pi-usage-block
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-usage-block"
  ]
}
```

Works out of the box for the bundled providers below. For other providers, install a matching usage provider plugin (e.g. `@d3ara1n/pi-provider-zhipu-coding-plan`).

## Bundled providers

The following pi providers are supported out of the box — no extra plugin needed. Built-ins register automatically on startup for every provider you've configured (i.e. have an API key for); a user-defined provider with the same id always takes precedence.

| Provider | Shows | Data source |
|----------|-------|-------------|
| OpenAI | quota % | `x-ratelimit-*-tokens` response headers |
| Anthropic | quota % | `anthropic-ratelimit-tokens-*` response headers |
| xAI (Grok) | quota % | `x-ratelimit-*-tokens` response headers |
| Cerebras | quota % | `x-ratelimit-*-tokens-minute` response headers |
| Together | quota % | `x-tokenlimit-*` response headers |
| OpenRouter | balance $ | `GET openrouter.ai/api/v1/credits` |
| DeepSeek | balance $ | `GET api.deepseek.com/user/balance` |
| OpenCode Go | dollar quota % | `GET opencode.ai/zen/go/v1/usage` |

> **Not supported:** Google Gemini and Mistral don't surface response headers in pi's call path. Groq's rate-limit headers are undocumented/unstable, and Fireworks only exposes limit (no remaining/reset).

## Configuration

### Powerline item

Add to your `settings.json` under `powerline.customItems` (see [`pi-powerline-footer`](https://pi.dev/packages/pi-powerline-footer) for the full custom item schema):

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

### Editor Shell integration

If you use [`pi-editor-shell`](https://pi.dev/packages/@d3ara1n/pi-editor-shell) to replace the default editor frame, you can pin the usage status to the shell's top-right corner via `editorShell.pinnedStatus`:

```json
{
  "editorShell": {
    "pinnedStatus": ["usage-block"]
  }
}
```

Pinned status keys are read from the shell's top-right corner on every paint, so usage updates appear in real-time alongside other pinned extensions.

### Refresh interval (polled providers only)

Optionally set the poll interval (default: 60 seconds). Applies to all `api`-source providers (quota and balance):

```json
{
  "usageBlock": {
    "refreshIntervalMs": 30000
  }
}
```

## Display format

A provider shows one of two shapes depending on its `kind`:

**quota** — consumed within a time window:

```
ProviderName 🟢53% ↺3h34m
```

**balance** — absolute remaining amount:

```
ProviderName 🟢$32.50
```

| Part | Meaning |
|------|---------|
| 🟢/🟡/🔴 | Severity (see thresholds below) |
| `53%` | Quota consumed (quota kind only) |
| `$32.50` | Balance remaining (balance kind only) |
| `↺3h34m` | Time until reset (quota, only if `resetAt` is supplied) |

Multiple quota windows from the same provider are shown side by side.

### Severity thresholds

Colour is a display-layer concern — it never appears on the provider data model:

- **quota** — on the `used/limit` ratio: `< 70%` green / `70–90%` yellow / `≥ 90%` red.
- **balance** — on the absolute `amount`, per currency (unknown currencies fall back to USD):

| currency | warning (yellow) | error (red) |
|----------|------------------|-------------|
| USD | < 25 | < 5 |
| CNY | < 175 | < 35 |

These are built-in defaults; per-provider overrides via settings are planned.

## How it works

1. Tracks the active provider via `ctx.model.provider` (from `session_start` and `model_select` events)
2. Looks up a registered `UsageProvider` whose `id` matches the active provider key
3. Queries usage based on the provider's `source`:
   - **api**: timer-based polling via `fetchUsage()` / `fetchBalance()`
   - **headers**: event-driven via `after_provider_response` + `parseHeaders()`
4. If no matching usage provider exists, the status bar is cleared

## `/usage` command

The `/usage` slash command shows usage for **all** registered usage providers in one view.

- **api**-source providers: calls `fetchUsage()` / `fetchBalance()` on demand (5-second timeout per provider)
- **headers**-source providers: shows the last known value from response headers, or `—` if no data is available yet

The active provider is marked with `*(active)*`.

```
**Usage — all providers**

Zhipu Coding Plan *(active)* (api)      🟢 43% ↺3h34m
OpenAI (api)                             🔴 89% ↺1h
Anthropic (headers)                      —
DeepSeek (api)                           🟢 $32.50
```

---

## Building a Usage Provider

A usage provider is a plugin that registers itself with the shared `usageRegistry` from `@d3ara1n/pi-usage-block-core`.

**This package is an npm dependency, not a pi extension.** Add it to your provider plugin's `package.json`:

```json
{
  "dependencies": {
    "@d3ara1n/pi-usage-block-core": "^3.0.0"
  }
}
```

### Key convention

The usage provider's `id` **must match** the pi provider key (the first argument to `pi.registerProvider()`):

```ts
// pi provider registration — this key is the shared identity
pi.registerProvider("zhipu-coding", { ... });

// usage provider registration — same key
usageRegistry.register({ kind: "quota", id: "zhipu-coding", ... });
```

This is how `pi-usage-block` knows which usage data belongs to the active provider.

### Provider shapes

`kind` (quota / balance) and `source` (api / headers) are orthogonal, so there are four combinations. The three common ones are shown below; `balance / headers` is rare (balances usually come from a dedicated API) but equally supported.

#### quota / api — Poll an external quota API

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
    kind: "quota",
    id: "my-provider",           // must match pi.registerProvider key
    name: "My Provider",
    source: "api",
    async fetchUsage() {
      // Call your provider's quota API
      const res = await fetch("https://api.example.com/quota", {
        headers: { Authorization: `Bearer ${process.env.MY_API_KEY}` },
      });
      const data = await res.json();

      // Return one QuotaWindow per quota window
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

#### quota / headers — Parse usage from response headers

For providers that include rate-limit / usage info in HTTP response headers (e.g. OpenAI-style `x-ratelimit-*` headers). Provide a `parseHeaders` function — `pi-usage-block` calls it on every `after_provider_response`. Header names are lower-cased.

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
    kind: "quota",
    id: "openai-compatible",      // must match pi.registerProvider key
    name: "My Provider",
    source: "headers",
    parseHeaders(h) {
      const limit = Number(h["x-ratelimit-limit-tokens"]);
      const remaining = Number(h["x-ratelimit-remaining-tokens"]);
      if (!limit) return null;
      // `used` is always consumed — convert remaining yourself.
      return [{
        period: "per-window",
        used: limit - remaining,
        limit,
        unit: "tokens",
      }];
    },
  });
}
```

Return `null` when the response carries no usable data (the previous value is kept). Remember `used` is **consumed** — if the header reports *remaining*, convert it (`used = limit - remaining`) so the severity colours read correctly. Note also that reset formats vary by provider (OpenAI sends a duration like `"6s"`, others a timestamp), which is exactly why parsing is left to your function.

#### balance — Poll a prepaid account balance

For providers backed by a prepaid account (e.g. OpenRouter, DeepSeek credit). Returns a single absolute amount + unit; no time window, no reset. `pi-usage-block` polls `fetchBalance()` on a timer.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-prepaid", {
    name: "My Prepaid",
    baseUrl: "https://api.example.com/v1",
    apiKey: "$MY_API_KEY",
    api: "openai-completions",
    models: [ ... ],
  });

  usageRegistry.register({
    kind: "balance",
    id: "my-prepaid",            // must match pi.registerProvider key
    name: "My Prepaid",
    source: "api",
    async fetchBalance() {
      const res = await fetch("https://api.example.com/balance", {
        headers: { Authorization: `Bearer ${process.env.MY_API_KEY}` },
      });
      const data = await res.json();
      return { amount: data.balance, currency: "USD" };
    },
  });
}
```

Balances are usually polled via a dedicated API (`source: "api"`). `source: "headers"` is also supported for the rare provider that reports a balance in response headers — provide `parseHeaders` instead of `fetchBalance`.

### Data types

```ts
interface QuotaWindow {            // kind: "quota"
  period: string;                  // Label, e.g. "5h", "daily"
  used: number;                    // Amount consumed (or percentage if limit=100)
  limit: number;                   // Maximum (use 100 for percentage-only)
  unit: "requests" | "tokens" | "dollars";
  resetAt?: Date;                  // When quota resets
}

interface BalanceInfo {            // kind: "balance"
  amount: number;                  // Remaining amount
  currency: string;                // ISO 4217 code, e.g. "USD", "CNY"
}
```

Return an empty array `[]` from `fetchUsage()` (or throw from `fetchBalance()`) when data is unavailable — the provider is treated as offline and the last known value is kept.

---

## Full API: @d3ara1n/pi-usage-block-core

```ts
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";

// Register a provider (quota or balance)
usageRegistry.register(provider: UsageProvider): void;

// Unregister
usageRegistry.unregister(id: string): void;

// Get a specific provider by id
usageRegistry.get(id: string): UsageProvider | undefined;

// Get all registered providers
usageRegistry.getAll(): UsageProvider[];
```

See [`@d3ara1n/pi-usage-block-core`](../pi-usage-block-core) for the full type definitions.
