# @d3ara1n/pi-usage-block-core

Shared types and registry for usage reporting in [Pi Coding Agent](https://pi.dev).

Provider-agnostic — any provider plugin can register itself, and any UI plugin (e.g. [`@d3ara1n/pi-usage-block`](../pi-usage-block)) can consume the data.

A provider is one of two **kinds**, discriminated by `kind`:

- **`quota`** — usage consumed within a time window (e.g. a 5h tokens quota). Has a natural denominator (`limit`), so the display shows a percentage.
- **`balance`** — an absolute prepaid amount on an account (e.g. $32.50 remaining). No window, no reset — just an amount and currency.

## Dependencies

None.

## Installation

```bash
npm install @d3ara1n/pi-usage-block-core
```

> This package is a **library**, not a standalone pi extension. It is installed automatically when used by a provider or UI plugin dependency; install it directly only when building against its API. For writing a provider end-to-end, see [`@d3ara1n/pi-usage-block`](../pi-usage-block#building-a-usage-provider).

## Types

### `UsageUnit`

Shared unit of measurement:

```ts
type UsageUnit = "requests" | "tokens" | "dollars";
```

### `QuotaWindow` — `kind: "quota"`

A single quota window (e.g. 5h tokens, weekly tokens).

```ts
interface QuotaWindow {
  period: string;        // label, e.g. "5h", "weekly"
  used: number;          // amount consumed (or percentage if limit=100)
  limit: number;         // maximum allowed (use 100 for percentage-only data)
  unit: UsageUnit;
  resetAt?: Date;        // when the quota resets; omit if unknown
}
```

### `BalanceInfo` — `kind: "balance"`

An absolute remaining balance with no time window.

```ts
interface BalanceInfo {
  amount: number;        // remaining amount, e.g. 32.5
  currency: string;      // ISO 4217 currency code, e.g. "USD", "CNY"
}
```

### `QuotaProvider`

```ts
interface QuotaProvider {
  kind: "quota";
  id: string;            // must match the pi provider key
  name: string;
  source: "api" | "headers";
  fetchUsage?(): Promise<QuotaWindow[]>;                              // [source="api"]
  parseHeaders?(headers: Record<string, string>): QuotaWindow[] | null;  // [source="headers"]
}
```

`source` picks how data is obtained (orthogonal to `kind`):

- **`api`** — `fetchUsage()` is polled periodically by the UI plugin.
- **`headers`** — `parseHeaders()` is called on every provider response.

### `BalanceProvider`

```ts
interface BalanceProvider {
  kind: "balance";
  id: string;            // must match the pi provider key
  name: string;
  source: "api" | "headers";
  fetchBalance?(): Promise<BalanceInfo>;                              // [source="api"]
  parseHeaders?(headers: Record<string, string>): BalanceInfo | null;      // [source="headers"]
}
```

`source` is orthogonal to `kind`, so balances may be polled (`api`) or read from response headers (`headers`).

### `UsageProvider`

Discriminated union of the two:

```ts
type UsageProvider = QuotaProvider | BalanceProvider;
```

## Registry

`usageRegistry` is a global singleton shared across all extensions via `globalThis`:

```ts
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";

// quota provider
usageRegistry.register({
  kind: "quota",
  id: "my-provider",
  name: "My Provider",
  source: "api",
  async fetchUsage() {
    return [{ period: "5h", used: 53, limit: 100, unit: "tokens" }];
  },
});

// balance provider
usageRegistry.register({
  kind: "balance",
  id: "my-prepaid",
  name: "My Prepaid",
  source: "api",
  async fetchBalance() {
    return { amount: 32.5, currency: "USD" };
  },
});
```

## API

```ts
usageRegistry.register(provider: UsageProvider): void;   // overwrites if id exists
usageRegistry.unregister(id: string): void;
usageRegistry.get(id: string): UsageProvider | undefined;
usageRegistry.getAll(): UsageProvider[];
usageRegistry.size: number;
```

## Why a separate package?

Pi extensions can load the same package under distinct module identities. Storing this registry on `globalThis` keeps provider and UI plugins connected across those identities and reloads.
