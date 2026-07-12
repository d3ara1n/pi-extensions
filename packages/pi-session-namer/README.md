# @d3ara1n/pi-session-namer

Auto-name pi sessions using a cheap side agent.

On the first user prompt of a new session, calls a lightweight side agent model
to generate a concise session title, then sets it via `pi.setSessionName()`.
Subsequent turns are skipped with near-zero overhead.

## Features

- **Zero-config**: Works out of the box with pi-model-roles' `utility` role
- **First-turn only**: Adds ~0.5-1s latency on the first prompt, zero overhead after
- **Graceful fallback**: If the side agent fails, truncates the user prompt as name
- **Manual rename**: `/namer:rename` to regenerate at any time

## Configuration

In `~/.pi/agent/settings.json`:

```jsonc
{
  "sessionNamer": {
    "enabled": true,
    "sideAgentRole": "utility",
    "maxLength": 50
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Global on/off switch |
| `sideAgentRole` | `"utility"` | pi-model-roles role for the naming side agent |
| `maxLength` | `50` | Maximum name length in characters; `0` means unlimited, and negative values are normalized to `0` |

Project-level `.pi/settings.json` overrides global settings.

## Commands

| Command | Description |
|---------|-------------|
| `/namer` | Show status and config |
| `/namer:enable` | Enable auto-naming for the current session |
| `/namer:disable` | Disable auto-naming for the current session |
| `/namer:rename` | Regenerate session name from last prompt |

The enable/disable commands are intentionally session-only. For a persistent choice, set `sessionNamer.enabled` in `settings.json`; the extension does not rewrite user configuration files.

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — model role resolution

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-session-namer
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-session-namer"
  ]
}
```
