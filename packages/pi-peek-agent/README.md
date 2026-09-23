# @d3ara1n/pi-peek-agent

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent)

Cross-instance peek for [pi](https://github.com/earendil-works/pi) — investigate another pi instance's session without disturbing its main conversation. Built on [`@d3ara1n/pi-mesh`](../pi-mesh) for discovery and transport.

Adds the `peek` tool. Discovery, identity, and the socket mesh live in pi-mesh — load pi-mesh alongside this package.

## How it works

Each call runs a temporary [`pi-peek`](../pi-peek) investigation on the target instance. The helper retrieves and summarizes its saved records; the caller handles evaluation and decisions. The target assistant does not receive the request.

- **Fresh snapshot per call** — include context when following up. Saved thinking is excluded unless `includeThinking` is enabled.
- **Live tool view** — the collapsed row shows activity and report character count, then the summary. The expanded view streams the Markdown report and stays at `…` before body text arrives.
- **Result details** — snapshot time, usage, request/tool counts, stop reason and `reportMode` (`tagged` or `fallback`) accompany the report.
- **Bounded lifetime** — the temporary snapshot and helper history are discarded after the call. Caller-session storage and model-provider retention are separate.

Tag parsing, retrieval budgets and cancellation are shared with [pi-peek](../pi-peek#investigation-lifecycle). The client also decodes raw-token streams from older peers using the shared parser.

## Tool

### `peek`

Investigate another instance's session without disturbing its main conversation.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `question` | yes | Information to locate in the session; include context for follow-ups. |
| `includeThinking` | no | Include readable thinking saved in the session. Defaults to false; missing/redacted thinking cannot be recovered. |
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
- [`@d3ara1n/pi-peek`](../pi-peek) — temporary active-context investigations

## Configuration

Optional, in `~/.pi/agent/settings.json` under `peek`:

```json
{
  "peek": {
    "investigateTimeoutMs": 120000,
    "timeoutMs": 90000,
    "role": "utility",
    "maxRounds": 6,
    "maxOutputTokens": 8192
  }
}
```

`investigateTimeoutMs` is the caller's transport wait timeout. `timeoutMs` is the serving instance's independent deadline for the entire investigation, including authentication, every model request and retrieval rounds. Set the caller's wait timeout longer than the serving instance's deadline, allowing for transport overhead.

Cancelling a caller's request or disconnecting does **not** currently propagate cancellation to the serving handler through the mesh protocol. Remote work is bounded by its own deadline and is aborted on session shutdown. No mesh protocol changes are required.

See [pi-peek configuration](../pi-peek#configuration) for model role, retrieval rounds, output budgets and deadline settings. Discovery/registry/heartbeat configuration belongs to pi-mesh's `mesh` block.

## Naming

Names are managed by pi-mesh — see the [pi-mesh README](../pi-mesh#naming). Each instance gets a stable name derived from its session id; override at startup with `PI_MESH_NAME`, or rename at runtime with `/mesh:rename`.

## License

MIT
