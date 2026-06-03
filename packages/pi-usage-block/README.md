# @d3ara1n/pi-usage-block

Usage quota status bar block for [Pi Coding Agent](https://pi.dev) — polls registered providers and displays quota in the powerline.

## Install

```bash
pi install npm:@d3ara1n/pi-usage-block
```

Requires at least one provider plugin that registers a `UsageProvider` (e.g. `@d3ara1n/pi-provider-zhipu-coding-plan`).

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

### Refresh interval

Optionally set the poll interval (default: 60 seconds):

```json
{
  "usageBlock": {
    "refreshIntervalMs": 30000
  }
}
```

## Display format

Each provider's quota is shown as:

```
ProviderName 🟢53% ↺3h34m
```

| Part | Meaning |
|------|---------|
| 🟢/🟡/🔴 | Usage threshold: < 70% / 70–90% / ≥ 90% |
| `53%` | Quota consumed |
| `↺3h34m` | Time until reset (only if provider supplies `resetAt`) |

Multiple providers are joined with ` │ `. Multiple quota windows from the same provider are shown side by side.

## How it works

- On `session_start`: fetches all providers and starts periodic refresh
- On `session_shutdown`: stops the timer and clears state
- Uses an `alive` guard + post-await checks to prevent crashes when the session is torn down mid-refresh

## Building a provider

Any extension can register a usage provider:

```ts
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";

usageRegistry.register({
  id: "my-provider",
  name: "My Provider",
  async fetchUsage() {
    return [{
      period: "daily",
      used: 50,
      limit: 100,
      unit: "tokens",
    }];
  },
});
```

See [`@d3ara1n/pi-usage-block-core`](../pi-usage-block-core) for the full API.
