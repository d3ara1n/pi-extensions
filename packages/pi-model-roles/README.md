# @d3ara1n/pi-model-roles

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-model-roles)](https://www.npmjs.com/package/@d3ara1n/pi-model-roles) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-model-roles)](https://www.npmjs.com/package/@d3ara1n/pi-model-roles) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-model-roles)](https://www.npmjs.com/package/@d3ara1n/pi-model-roles)

Give pi's background sub-tasks — naming sessions, routing, side agents — their own model and thinking level, instead of running every throwaway job on your main (expensive) model.

Named **roles** (`heavy`, `fast`, `utility`, …) each map to a model + thinking level. Other pi extensions ask model-roles "which model fits this job?" and get the right one back, auth already resolved.

## Why roles

Without model-roles, every background task either hardcodes its own model (inflexible) or piggybacks on your active model (a throwaway "title this session" call burns your premium budget). Roles centralize the decision: declare once in settings, every consumer respects it. Cheap jobs route to cheap models; deep-thinking jobs get the strong model.

## Who uses it

You'll usually meet model-roles through one of these extensions — none of them require you to touch the API yourself:

- **pi-scout** — picks the side-agent's model from your visible roles
- **pi-subagent** — assigns models to delegated sub-tasks
- **pi-session-namer** — titles your chat sessions via the `utility` role (it reads the **entire** conversation)
- **pi-peek** — runs lightweight cross-instance lookups

If you're not writing a pi extension, the sections down to **Configuration** are all you need.

## Dependencies

None.

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles"
  ]
}
```

This is an **extension dependency**, not a passive npm-only library. It must appear in pi's `extensions` array alongside every consumer so its `session_start` hook initializes the shared API — installing it as an npm dependency alone does not load it.

## Default roles

Works out of the box — no configuration required.
Built-in defaults use `model: null` (use pi's current model, don't switch):

| Role | model | thinking | Description |
|------|-------|----------|-------------|
| `default` | null | medium | Regular dev tasks: new features, code edits, code review, adding tests, general debugging, single-file changes |
| `heavy` | null | high | Deep-thinking tasks: cross-file refactoring, architecture design, complex bug debugging, performance optimization, security analysis, DB schema changes, multi-module migrations |
| `fast` | null | low | Simple deterministic tasks: one-line edits, formatting, simple Q&A, doc lookups, git operations, confirmations |
| `utility` | null | off | Lightweight utility tasks: routing, commit gen, title summarization |

`model: null` means "keep using whatever model pi currently has".
Only `thinking` level differs between roles by default.

## Model selection guide

The defaults all use `model: null`, so every role runs on your current model — fine to start, but you're paying premium prices for throwaway work. Assign models per role to cut cost and latency:

| Role | Recommendation | Why |
|------|----------------|-----|
| `utility` | `deepseek/deepseek-v4-flash`, thinking `off` | Used for session naming and similar jobs that read the **whole conversation** at once — so it needs a large context window. It runs often and you never read its output, so it must be nearly free. And it runs in the background, so it must answer fast enough not to block the main flow. DeepSeek V4 Flash nails all three: huge context, dirt cheap, snappy. |
| `fast` | a cheap, fast model, e.g. `google/gemini-2.5-flash`, thinking `low`/`off` | One-line edits, formatting, lookups — throughput and latency matter more than depth. |
| `heavy` | your strongest reasoning model, e.g. `anthropic/claude-opus-4`, thinking `high` | Reserve for genuinely hard, cross-cutting work; running it on everything wastes budget. |
| `default` | leave `null` | Keeps using your everyday model; `medium` thinking suits most work. |

Concrete config:

```jsonc
{
  "modelRoles": {
    "roles": {
      "heavy": { "model": "anthropic/claude-opus-4" },
      "fast": { "model": "google/gemini-2.5-flash", "thinking": "off" },
      "utility": { "model": "deepseek/deepseek-v4-flash", "thinking": "off" }
    }
  }
}
```

## Configuration

Override specific roles in `~/.pi/agent/settings.json`:

```jsonc
{
  "modelRoles": {
    "roles": {
      "heavy": {
        "model": "anthropic/claude-opus-4"
      },
      "fast": {
        "model": "google/gemini-2.5-flash",
        "thinking": "off"
      },
      "utility": {
        "model": "deepseek/deepseek-v4-flash",
        "thinking": "off"
      }
    },
    "defaultRole": "default"
  }
}
```

User settings merge with built-in defaults: only override roles you want to change. You can also add entirely new roles — any name works.

### Role fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | `string \| null` | `null` | `"provider/model-id"` or `null` = use current model |
| `thinking` | `string` | *(unset — passes through)* | `"off"` `"minimal"` `"low"` `"medium"` `"high"` `"xhigh"`; omit to leave reasoning untouched |
| `description` | `string` | | Human-readable description |
| `hidden` | `boolean` | `false` | Hide from user-facing listings |

## Tools and commands

- `list_models` — tool that lists available `provider/model-id` values from pi's model registry (handy for confirming an ID before referencing it)
- `/roles` — shows configured roles and their resolved models

---

## For extension authors

Everything below is for code that imports `getModelRolesAPI`. Role-only users can stop here.

```typescript
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";

const roles: ModelRolesAPI = getModelRolesAPI();

// Resolve a role — always returns a real model or undefined
const resolved = await roles.resolveRoleAsync("heavy");
if (resolved.model) {
  // Use resolved.model, resolved.apiKey, resolved.headers
  // model=null in config is transparently resolved to pi's current model
} else {
  // Model not available
}

// Reverse lookup
roles.findRoleByModel("anthropic/claude-opus-4"); // "heavy"

// "Which role is the currently-active model?" — recognizes the default role
// even when all roles are model=null (the common case), so callers (e.g.
// pi-scout's router) have a real baseline instead of "unknown".
roles.getCurrentRole("anthropic/claude-sonnet-4");
```

### Hidden roles

Roles with `hidden: true` are excluded from `getVisibleRoles()` — the list pi-scout's router picks the side-agent model from, so the side agent won't suggest switching to them. They can still be used directly by name (e.g. as `sideAgentRole` in scout config) and resolved via `resolveRole()` / `resolveRoleAsync()`. `utility` is hidden by default.

### Unknown-role fallback

A missing role requested through `resolveRole()`, `resolveRoleAsync()`, `completeWithRole()`, or `streamWithRole()` uses `defaultRole`'s configuration once; if that cannot resolve, the call falls back to the current model when applicable or reports no model. The returned `ResolvedRole.name` remains the unknown requested name, and `getRole()` continues to return only explicitly defined roles.

## License

MIT
