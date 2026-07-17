# @d3ara1n/pi-model-roles

Model role configuration library for [pi](https://github.com/earendil-works/pi) extensions.

Defines named model roles (e.g. "heavy", "fast", "utility") and resolves them to pi `Model` instances with API key and headers.

## What it does

- Reads role definitions from `~/.pi/agent/settings.json` → `modelRoles` field
- Resolves role names to `Model<Api>` instances via pi's `ModelRegistry`
- Exposes a `ModelRolesAPI` singleton for other extensions to consume via direct import
- Registers the `/roles` command and session/model hooks that initialize and maintain the singleton

This package is an **extension dependency**, not a passive npm-only library. It
must be listed in pi's `extensions` array alongside every consumer so its
`session_start` hook initializes the shared API. Installing it as an npm
dependency alone does not load the extension.

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

## Default Roles

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

Custom roles can be added freely — any role name works:

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
      // Lightweight utility tasks (routing, commit generation, etc.)
      "utility": {
        "model": "deepseek/deepseek-v4-flash",
        "thinking": "off"
      }
    },
    "defaultRole": "default"
  }
}
```

User settings merge with built-in defaults: only override roles you want to change.
You can also add entirely new roles. A missing role requested through
`resolveRole()`, `resolveRoleAsync()`, `completeWithRole()`, or `streamWithRole()`
uses `defaultRole`'s configuration once; if that configuration cannot resolve, the
call falls back to the current model when applicable or reports no model. The
returned `ResolvedRole.name` remains the unknown requested name, and `getRole()`
continues to return only explicitly defined roles.

### Hidden roles

Roles with `hidden: true` (like `utility` by default) are excluded from scout's role
selection list — the side agent won't suggest switching to them. They can still be
used directly by name (e.g. as `sideAgentRole` in scout config) and resolved via
`resolveRole()` / `resolveRoleAsync()`.

### Role fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | `string \| null` | `null` | `"provider/model-id"` or `null` = use current model |
| `thinking` | `string` | | `"off"` `"minimal"` `"low"` `"medium"` `"high"` `"xhigh"` |
| `description` | `string` | | Human-readable description |
| `hidden` | `boolean` | `false` | Hide from user-facing listings |

## Tools and Commands

- `list_models` — lists available `provider/model-id` values from pi's model registry
- `/roles` — shows configured roles and their resolved models

## API (for extension authors)

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

## License

MIT
