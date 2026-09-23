# @d3ara1n/pi-peek-agent

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent)

Cross-instance peek for [pi](https://github.com/earendil-works/pi) — investigate another pi instance's session without disturbing its main conversation. Built on [`@d3ara1n/pi-mesh`](../pi-mesh) for discovery and transport.

Adds the `peek` tool. Discovery, identity, and the socket mesh live in pi-mesh — load pi-mesh alongside this package.

## How it works

- **Read-after-burn**: the peeked instance creates a temporary investigation via [`pi-peek`](../pi-peek), makes one streaming completion, then disposes its reference and history. Its main agent is never touched. The caller receives a normal tool result that may be saved in its own session; model-provider retention is separate.
- **Active context**: the large-context utility model receives the peer's active, compaction-aware context view — exactly what the peer's main assistant currently sees (last compaction summary plus everything kept after it), including full saved tool arguments/results within that view. No internal tools, retrieval loop, pagination, or local truncation. Thinking is excluded unless the caller explicitly sets `includeThinking: true`.
- **Independent calls**: every request captures a fresh snapshot. There is no remote conversation handle, so include sufficient context when asking a follow-up.
- **Compact tool view**: the investigator is asked to include a short summary and a complete report in the same response, each between matching opening and closing tags. When both pairs match, only the report is returned to the calling model and shown in the expanded TUI (rendered as Markdown); the summary is used for the collapsed row. The parser never imposes a length limit on either field. Whitespace around and between the tag pairs (leading blank lines, a blank line between `</peek-summary>` and `<peek-report>`, trailing newlines) is tolerated; anything else that does not match the format is returned unchanged as the report, and the collapsed row uses its first non-empty line, truncated to terminal width. This format request belongs to pi-peek-agent only; pi-peek and pi-peek-user are unaffected.
- **Progress and limits**: live progress works in TUI and non-TUI hosts. While the report streams in, the collapsed row shows a `stage · chars` overview (e.g. `investigating · 1.2k chars`); the expanded row shows the question as a muted line and streams the report itself — the summary/tags envelope is filtered out incrementally, with raw passthrough when the output does not conform. The authoritative envelope split still happens on the peer when the response completes. Final result details include the snapshot time, usage, and stop reason when supplied by the peer. An upstream output limit adds a separate notice alongside the unchanged report; context overflow is surfaced as an error without automatic compression or retry.
- **On the mesh**: this package registers an `"investigate"` handler on the pi-mesh transport; a remote `peek` call routes there and runs locally. Identity, discovery, and peer listing are pi-mesh's job — use `mesh_list` to see who's online.

## Tool

### `peek`

Investigate another instance's session without disturbing its main conversation.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `question` | yes | What you want to find out about that instance's session (e.g. `"What are you working on right now?"`). |
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
    "role": "utility"
  }
}
```

`investigateTimeoutMs` is the caller's transport wait timeout. `timeoutMs` is the serving instance's independent request deadline, including authentication and streaming. Set the caller's wait timeout longer than the serving instance's request deadline, allowing for transport overhead.

Cancelling a caller's request or disconnecting does **not** currently propagate cancellation to the serving handler through the mesh protocol. Remote work is bounded by its own deadline and is aborted on session shutdown. No mesh protocol changes are required.

See [pi-peek configuration](../pi-peek#configuration) for model role and request deadline settings. Discovery/registry/heartbeat configuration belongs to pi-mesh's `mesh` block.

## Naming

Names are managed by pi-mesh — see the [pi-mesh README](../pi-mesh#naming). Each instance gets a stable name derived from its session id; override at startup with `PI_MESH_NAME`, or rename at runtime with `/mesh:rename`.

## License

MIT
