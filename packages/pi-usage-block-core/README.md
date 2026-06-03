# @d3ara1n/pi-usage-block-core

Shared types and registry for usage quota reporting in [Pi Coding Agent](https://pi.dev).

Provider-agnostic — any provider plugin can register itself, and any UI plugin can consume the data.

## Install

```bash
pi install npm:@d3ara1n/pi-usage-block-core
```

> This package is a **library**, not a standalone extension. You don't need to install it directly unless you're building a provider or UI plugin.

## Interfaces

### `UsageWindow`

A single quota window (e.g. 5h tokens, weekly tokens).

```ts
interface UsageWindow {
  period: string;                    // e.g. "5h", "weekly"
  used: number;                      // amount consumed (or percentage if limit=100)
  limit: number;                     // maximum allowed (use 100 for percentage-only data)
  unit: "requests" | "tokens" | "dollars";
  resetAt?: Date;                    // when the quota resets; omit if unknown
}
```

### `UsageProvider`

Implemented by provider plugins to report usage data.

```ts
interface UsageProvider {
  id: string;                        // e.g. "zhipu-coding"
  name: string;                      // e.g. "Zhipu Coding"
  icon?: string;                     // optional display icon
  fetchUsage(): Promise<UsageWindow[]>;
}
```

## Registry

The `UsageRegistry` is a global singleton shared across all extensions via `globalThis`:

```ts
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";

// In your provider extension:
usageRegistry.register({
  id: "my-provider",
  name: "My Provider",
  async fetchUsage() {
    return [{ period: "daily", used: 50, limit: 100, unit: "tokens" }];
  },
});

// In your UI extension:
const providers = usageRegistry.getAll();
for (const p of providers) {
  const windows = await p.fetchUsage();
}
```

## Why a separate package?

Pi loads extensions from the same `node_modules` tree. By sharing a registry package with a `globalThis` singleton, provider and UI plugins can communicate without knowing about each other — even across jiti module reloads.
