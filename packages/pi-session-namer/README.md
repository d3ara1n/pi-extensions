# @d3ara1n/pi-session-namer

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-session-namer)](https://www.npmjs.com/package/@d3ara1n/pi-session-namer) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-session-namer)](https://www.npmjs.com/package/@d3ara1n/pi-session-namer) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-session-namer)](https://www.npmjs.com/package/@d3ara1n/pi-session-namer)

Session naming for pi with layered correction paths.

On the first user prompt of a new session, a lightweight side agent generates a
concise title so the session is never "Untitled". When the initial name goes
stale (the session drifted from its opening message), two correction paths are
available: `/namer:rename` regenerates from the accumulated user-message window,
and the `rename_session` tool lets the main agent name the session directly —
the agent's full context is the best naming source.

## Features

- **Zero-config**: Works out of the box with pi-model-roles' `utility` role
- **First-turn only**: Adds ~0.5-1s latency on the first prompt, zero overhead after
- **Graceful fallback**: If the side agent fails, truncates the user prompt as name
- **Manual rename**: `/namer:rename` regenerates from the user's messages —
  up to 10, windowed to the first 5 and last 5 (the opening defines why the
  session exists, the latest shows what it became) when the session is longer
- **Agent rename**: `rename_session` tool lets the main agent set the session
  name on the user's request, with the full conversation as its source

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
| `/namer:rename` | Regenerate session name from the user's messages |

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
