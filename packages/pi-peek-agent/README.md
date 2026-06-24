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

## Install

```bash
pi extension add @d3ara1n/pi-peek          # install first — provides the consult core
pi extension add @d3ara1n/pi-peek-agent
```

Both must be in `settings.json` extensions. `pi-peek` registers hooks that track the main agent and initialize the consult backend; `pi-peek-agent` registers the `peek`/`peek_list` tools that call into it.

## Configuration

Optional, in `~/.pi/agent/settings.json` under `peek`:

```jsonc
{
  "peek": {
    "registryDir": "~/.pi/peek/registry",  // marker directory
    "heartbeatMs": 15000,                    // refresh lastSeen interval
    "staleMs": 45000,                        // peer considered stale after this
    "askTimeoutMs": 30000                    // peek() sync wait timeout
  }
}
```

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
