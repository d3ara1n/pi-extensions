# ⚠️ Deprecated — `@d3ara1n/pi-provider-zhipu-coding-plan`

This package is **deprecated** and no longer needed. It is superseded by pi's
built-in Zhipu / Z.AI providers plus the usage block's bundled quota reporting.

## What replaced it

**Providers** — pi now bundles the Zhipu / Z.AI coding-plan providers out of the
box, so there is nothing to install for model access:

| pi provider key | Region | Coding endpoint |
|-----------------|--------|-----------------|
| `zai` | International | `api.z.ai/api/coding/paas/v4` |
| `zai-coding-cn` | China mainland | `open.bigmodel.cn/api/coding/paas/v4` |

**Usage display** — token quota reporting (`🟢53% ↺3h34m`) for both is now built
into [`@d3ara1n/pi-usage-block`](../pi-usage-block). No separate provider plugin
is required; the 5h / weekly quota windows and reset countdown are sourced from
the provider's own quota API.

## How to migrate

1. Remove this extension from `~/.pi/agent/settings.json`.
2. Switch to the bundled provider — just set the API key env var:
   - China mainland: `zai-coding-cn` → `ZAI_CODING_CN_API_KEY`
   - International: `zai` → `ZAI_API_KEY`
3. Keep [`@d3ara1n/pi-usage-block`](../pi-usage-block) installed for the
   status-bar quota display.
