# @d3ara1n/pi-peek-agent

Cross-instance peek for [pi](https://github.com/earendil-works/pi) — let one pi instance glance at, or ask a question to, another instance without disturbing it.

Adds two tools for the main agent (`peek_list`, `peek`) and runs a lightweight Unix domain socket mesh so instances can discover and consult each other.

## How it works

- **Discovery**: each instance writes a tiny PID-file marker to `~/.pi/peek/registry/`. Liveness is verified by `kill(pid, 0)` + a socket connect probe — no heartbeat drift, no stale leftovers (the kernel reclaims the socket fd on exit, including SIGKILL/crash).
- **Transport**: Unix domain sockets via `node:net` (zero runtime dependencies). The connection is bidirectional, so the answer streams token-by-token.
- **Read-after-burn**: the peeked instance's main agent is never touched. The answer comes from its side `utility` model via the shared [`pi-peek`](../pi-peek) consult core.

## Tools

### `peek_list`

List other pi instances online, grouped by project. Peers appear only if they have `pi-peek-agent` loaded.

### `peek`

Ask another instance a question without disturbing its main conversation.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `question` | yes | The question to ask. |
| `at` | no | Target instance name (e.g. `"Fox"`). Omit to auto-pick the other same-project instance. |
| `sessionId` | no | Pin a specific instance by sessionId (use when names collide). |

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-peek
pi install npm:@d3ara1n/pi-peek-agent
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-peek",
    "/absolute/path/to/pi-extensions/packages/pi-peek-agent"
  ]
}
```

## Dependencies

- [`@d3ara1n/pi-peek`](../pi-peek) — consult core (serialize + investigate + tracker)

## Configuration

Optional, in `~/.pi/agent/settings.json` under `peek`:

```json
{
  "peek": {
    "registryDir": "~/.pi/peek/registry",
    "heartbeatMs": 15000,
    "askTimeoutMs": 30000,
    "role": "utility"
  }
}
```

`registryDir` accepts a leading `~`. `heartbeatMs` and `askTimeoutMs` must be positive finite numbers; invalid values fall back to their defaults.

## Naming

Each instance gets a stable display name shown in `peek_list`. The name is
**derived deterministically from the session id** (a hash into an
adjective+noun pool) — so the same session always gets the same name across
`/reload`, restarts, even across machines. Switching sessions (resume / fork /
new) yields a different name.

Set it explicitly to override:

```bash
PI_PEEK_NAME=Fox pi
```

Otherwise the derived name (e.g. `QuietBrook`) is used. Name collisions across
sessions are disambiguated by `peek({sessionId})`.

## License

MIT
