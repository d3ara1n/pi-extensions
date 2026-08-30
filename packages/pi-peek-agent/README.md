# @d3ara1n/pi-peek-agent

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent)

Cross-instance peek for [pi](https://github.com/earendil-works/pi) — ask another pi instance a question without disturbing its main conversation. Built on [`@d3ara1n/pi-mesh`](../pi-mesh) for discovery and transport.

Adds the `peek` tool. Discovery, identity, and the socket mesh live in pi-mesh — load pi-mesh alongside this package.

## How it works

- **Read-after-burn**: the peeked instance's main agent is never touched. The answer comes from its side `utility` model via the shared [`pi-peek`](../pi-peek) consult core.
- **On the mesh**: this package registers an `"ask"` handler on the pi-mesh transport; a remote `peek` call routes there and is answered locally. Identity, discovery, and peer listing are pi-mesh's job — use `mesh_list` to see who's online.

## Tool

### `peek`

Ask another instance a question without disturbing its main conversation.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `question` | yes | What you want to find out about that instance's session (e.g. `"What are you working on right now?"`). |
| `at` | no | Target instance name (e.g. `"Fox"`). Omit to auto-pick the other same-project instance. |
| `sessionId` | no | Pin a specific instance by sessionId (use when names collide). |

> Peer discovery moved to pi-mesh — use `mesh_list` (provided by `pi-mesh`) to see who's online.

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-peek
pi install npm:@d3ara1n/pi-mesh
pi install npm:@d3ara1n/pi-peek-agent
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-peek",
    "/absolute/path/to/pi-extensions/packages/pi-mesh",
    "/absolute/path/to/pi-extensions/packages/pi-peek-agent"
  ]
}
```

## Dependencies

- [`@d3ara1n/pi-mesh`](../pi-mesh) — peer discovery + transport
- [`@d3ara1n/pi-peek`](../pi-peek) — consult core (serialize + investigate)

## Configuration

Optional, in `~/.pi/agent/settings.json` under `peek`:

```json
{
  "peek": {
    "askTimeoutMs": 120000,
    "role": "utility"
  }
}
```

`askTimeoutMs` must be a positive finite number. Discovery/registry/heartbeat config moved to pi-mesh's `mesh` block.

## Naming

Names are managed by pi-mesh — see the [pi-mesh README](../pi-mesh#naming). Each instance gets a stable name derived from its session id; override at startup with `PI_MESH_NAME`, or rename at runtime with `/mesh:rename`.

## License

MIT
