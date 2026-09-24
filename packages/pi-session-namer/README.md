# @d3ara1n/pi-session-namer

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-session-namer)](https://www.npmjs.com/package/@d3ara1n/pi-session-namer) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-session-namer)](https://www.npmjs.com/package/@d3ara1n/pi-session-namer) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-session-namer)](https://www.npmjs.com/package/@d3ara1n/pi-session-namer)

Session naming for pi with layered correction paths.

On the first user prompt of a new session, a lightweight side agent generates a
concise title so the session is never "Untitled". When the initial name goes
stale (the session drifted from its opening message), `/namer:rename` can
regenerate from a conversation excerpt, and
the `rename_session` tool lets the main agent name the session directly —
the agent's full context is the best naming source.
Optionally, generated titles can also be refreshed after the 5th, 10th, 20th,
50th, and 100th completed user turns.

## Features

- **Zero-config**: Works out of the box with pi-model-roles' `utility` role
- **First-turn naming**: Names new sessions asynchronously on the opening prompt;
  later naming calls happen only if periodic renaming is enabled
- **Graceful fallback**: If the side agent fails, truncates the user prompt as name
- **Manual rename**: `/namer:rename` regenerates from a conversation excerpt —
  each turn pairs a user prompt with the assistant's closing reply (the user
  gives direction, the assistant carries the substance); up to 8 turns,
  windowed to the first 4 and last 4 (the opening defines why the session
  exists, the latest shows what it became) when the session is longer
- **Optional periodic rename**: Uses the same excerpt as `/namer:rename` after
  completed turns 5, 10, 20, 50, and 100; disabled by default. Explicitly set
  titles (via `/name` or `rename_session`) are never overwritten. Existing
  titles without plugin provenance are also left alone.
- **Agent rename**: `rename_session` tool lets the main agent set the session
  name on the user's request, with the full conversation as its source

## Configuration

In `~/.pi/agent/settings.json`:

```jsonc
{
  "sessionNamer": {
    "enabled": true,
    "periodicRename": false,
    "sideAgentRole": "utility",
    "maxLength": 50
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Global on/off switch |
| `periodicRename` | `false` | Refresh plugin-generated titles after completed turns 5, 10, 20, 50, and 100; set to `true` to enable |
| `sideAgentRole` | `"utility"` | pi-model-roles role for the naming side agent |
| `maxLength` | `50` | Maximum name length in characters; `0` means unlimited, and negative values are normalized to `0` |

Project-level `.pi/settings.json` overrides global settings.

## Commands

| Command | Description |
|---------|-------------|
| `/namer` | Show status and config |
| `/namer:enable` | Enable auto-naming for the current session |
| `/namer:disable` | Disable auto-naming for the current session |
| `/namer:rename` | Regenerate session name from the conversation excerpt |

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
