# Provider Plugin Conventions

> Provider plugins register LLM API providers with pi's model registry. They are thin wrappers — no hooks, no UI panels, no commands.

## Naming

- **Package name**: `pi-provider-<service>` (e.g. `pi-provider-zhipu-coding-plan`)
- **npm scope**: `@d3ara1n/pi-provider-<service>`
- **Commit scope**: `(pi-provider-<service>)`

## Provider Registration

A provider plugin registers one or more providers via `pi.registerProvider()`.

### Subscription vs. Pay-per-Use

If a provider offers both a subscription plan and pay-per-use billing, register **separate providers** for each:

| Provider ID | Display Name | Billing | Cost |
|---|---|---|---|
| `<service>` | `<Service Name>` | Pay-per-use | Actual per-token costs |
| `<service>-plan` | `<Service Name> (<OfficialPlanName>)` | Subscription | All zeros |

- Subscription provider IDs end with `-plan`
- Subscription provider `name` includes `(Plan)` suffix
- Subscription models have `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`

### Model Configuration

- **Static model list** — hardcode models in the plugin. No dynamic discovery.
- Maintain the list as models change; update the plugin when new models are released.

### Authentication

Two auth modes:

1. **`/login` flow** — provider uses pi's built-in OAuth/login. No env var needed.
2. **Environment variable** — set `apiKey: "$VAR_NAME"` in provider config.

Env var naming:

- If the provider has an official env var convention, use it
- Otherwise use `<SERVICE>_API_KEY` (e.g. `ZHIPUAI_API_KEY`, `SENSENOVA_API_KEY`)

## Usage Reporting

### Rule: Report only if the provider officially exposes a quota/balance API

- If the provider has a documented usage/quota/balance endpoint → integrate via `@d3ara1n/pi-usage-block-core`
- If not → skip it. Don't implement fake or reverse-engineered reporting. Wait until the provider officially releases the API.

### Usage provider `id` must match the pi provider key

The usage provider's `id` must be identical to the first argument of `pi.registerProvider()`. This is the sole link between the pi provider and its usage data.

### API key resolution for usage

Usage providers need the API key to call the provider's quota API. Resolve it at runtime from `modelRegistry` (captured via `session_start` event), not from environment variables directly.

## Dependencies

- **`@d3ara1n/pi-usage-block-core`** — only in `dependencies` if reporting usage
- **No other pi extension dependencies** — provider plugins are standalone
