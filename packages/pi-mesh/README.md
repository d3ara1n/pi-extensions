# @d3ara1n/pi-mesh

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-mesh)](https://www.npmjs.com/package/@d3ara1n/pi-mesh) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-mesh)](https://www.npmjs.com/package/@d3ara1n/pi-mesh) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-mesh)](https://www.npmjs.com/package/@d3ara1n/pi-mesh)

Agent mesh for [pi](https://github.com/earendil-works/pi) — peer discovery and cross-instance transport. The neutral foundation that [`pi-peek-agent`](../pi-peek-agent) and [`pi-chat-room`](../pi-chat-room) build on.

Self-sufficient: install alone to discover other pi instances and self-declare a role. Knows nothing about peek, chat, or any specific workflow — it just discovers named peers and carries typed bytes between them.

## How it works

- **Discovery**: each instance writes a PID-file marker to `~/.pi/mesh/registry/`. Liveness is verified by `kill(pid, 0)` + a socket connect probe — no heartbeat drift, no stale leftovers (the kernel reclaims the socket fd on exit, including SIGKILL/crash).
- **Transport**: Unix domain sockets via `node:net` (zero runtime dependencies). Requests are routed by a caller-defined `type` string to handlers registered via `serve()`; consumers (`pi-peek-agent`'s `"ask"`, `pi-chat-room`'s `"message"`) define their own types.
- **Identity**: each instance gets a stable name derived deterministically from its session id (a hash into an adjective+noun pool). Renameable at runtime. `PI_MESH_NAME` overrides.
- **Profile**: runtime role/description other agents see — the "name card" for multi-agent workflows.

## Tools

### `mesh_list`

List other pi instances online, with each peer's name, cwd, model, git branch, and self-declared role. Same-project peers first.

### `mesh_get_profile`

Read a peer's (or your own) role/description and basic identity.

### `mesh_set_profile`

Declare or update this instance's role and description — how you self-introduce on the mesh.

## Commands

- `/mesh:rename <name>` — override the derived identity name
- `/mesh:status` — show self info, registry dir, and online peers

## Installation

```bash
pi install npm:@d3ara1n/pi-mesh
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-mesh"
  ]
}
```

## Dependencies

None beyond the `pi` framework itself.

## Configuration

Optional, in `~/.pi/agent/settings.json` under `mesh`:

```json
{
  "mesh": {
    "registryDir": "~/.pi/mesh/registry",
    "heartbeatMs": 15000
  }
}
```

`registryDir` accepts a leading `~`. `heartbeatMs` must be a positive finite number.

## Naming

Each instance gets a stable display name shown by `mesh_list`. The name is derived deterministically from the session id (hash → adjective+noun pool), so the same session always gets the same name across `/reload`, restarts, even machines. Renameable at runtime via `/mesh:rename`.

Override at startup:

```bash
PI_MESH_NAME=Fox pi
```

Otherwise the derived name (e.g. `QuietBrook`) is used. Name collisions are flagged in `mesh_list`; disambiguate by `sessionId`.

## Order-agnostic consumers

Extensions that depend on pi-mesh register their `serve()` handlers via the `mesh:ready` event (+ a `tryGetMeshAPI` fallback), so load order in `settings.json` is irrelevant — put pi-mesh anywhere.

## License

MIT
