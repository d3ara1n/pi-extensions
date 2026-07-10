# pi-provider-agnes — Usage Quota/Balance Integration Plan

> **Status**: NOT IMPLEMENTED — blocked by lack of public API.
> Agnes AI does not currently expose a quota or balance endpoint.
> When they do, follow this plan to integrate via `@d3ara1n/pi-usage-block-core`.

## Overview

Two providers, two different usage models:

| Provider | Billing Model | Usage Kind | Source |
|---|---|---|---|
| `agnes` | Token billing (prepaid) | `balance` | API (poll balance endpoint) |
| `agnes-plan` | Subscription quota | `quota` | API (poll quota endpoint) or headers |

## Integration Steps

### 1. Add dependency

```json
"dependencies": {
  "@d3ara1n/pi-usage-block-core": "^3.0.0"
}
```

### 2. `agnes` — Balance Provider

When Agnes exposes a balance API (e.g. `GET /v1/account/balance`), implement:

```typescript
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";
import type { BalanceProvider, BalanceInfo } from "@d3ara1n/pi-usage-block-core";

const BALANCE_API = "https://apihub.agnes-ai.com/v1/account/balance"; // TBD

async function fetchBalance(apiKey: string): Promise<BalanceInfo> {
  const res = await fetch(BALANCE_API, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  // Parse response — field names TBD
  const data = await res.json();
  return { amount: data.remaining, currency: data.currency ?? "USD" };
}
```

Register:

```typescript
let modelRegistry: any;

usageRegistry.register({
  kind: "balance",
  id: "agnes",
  name: "Agnes AI",
  source: "api",
  async fetchBalance() {
    if (!modelRegistry) throw new Error("not ready");
    const apiKey = await modelRegistry.getApiKeyForProvider("agnes");
    if (!apiKey) throw new Error("no key");
    return fetchBalance(apiKey);
  },
} satisfies BalanceProvider);
```

### 3. `agnes-plan` — Quota Provider

Depends on what Agnes exposes. Options:

**A) Quota API** (preferred):

```typescript
import type { QuotaProvider, QuotaWindow } from "@d3ara1n/pi-usage-block-core";

const QUOTA_API = "https://apihub.agnes-ai.com/v1/account/quota"; // TBD

usageRegistry.register({
  kind: "quota",
  id: "agnes-plan",
  name: "Agnes AI (Plan)",
  source: "api",
  async fetchUsage(): Promise<QuotaWindow[]> {
    // Poll Agnes quota API
    // Map response to QuotaWindow[] (period, used, limit, unit, resetAt)
  },
} satisfies QuotaProvider);
```

Known quota windows from model catalog (2026-06-28):

| Plan | Text (5h) | Text (weekly) | Image (daily) | Video (daily) |
|---|---|---|---|---|
| Starter | 1,500 req | 15,000 req | 4,000 images | 500s |
| Plus | 7,500 req | 75,000 req | 4,000 images | 500s |
| Pro | 30,000 req | 300,000 req | 4,000 images | 500s |

**B) Response headers** (if Agnes adds `x-ratelimit-*` headers):

```typescript
usageRegistry.register({
  kind: "quota",
  id: "agnes-plan",
  name: "Agnes AI (Plan)",
  source: "headers",
  parseHeaders(headers): QuotaWindow[] | null {
    const remaining = headers["x-ratelimit-remaining-requests"];
    const limit = headers["x-ratelimit-limit-requests"];
    const reset = headers["x-ratelimit-reset-requests"];
    if (!remaining || !limit) return null;
    return [{
      period: "window",
      used: Number(limit) - Number(remaining),
      limit: Number(limit),
      unit: "requests",
      resetAt: reset ? new Date(Number(reset) * 1000) : undefined,
    }];
  },
} satisfies QuotaProvider);
```

### 4. Capture modelRegistry

```typescript
pi.on("session_start", (_e, c) => {
  modelRegistry = (c as any).modelRegistry;
});
```

## Cost Values

When Agnes introduces official token pricing, update `agnes` provider cost:

```typescript
// Current placeholder (legacy pricing)
cost: { input: 0.03, output: 0.15, cacheRead: 0, cacheWrite: 0 }

// Update to actual pricing when available
```

## Notes

- `id` must match the pi provider key (`"agnes"` / `"agnes-plan"`) so pi-usage-block's status bar can correlate.
- If Agnes provides response headers with quota/balance info, prefer `source: "headers"` — it's realtime and requires no polling.
- `fetchUsage()` should return `[]` (not throw) when the API is unreachable — pi-usage-block treats this as "offline" and keeps the last known value.
