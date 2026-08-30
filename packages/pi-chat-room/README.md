# @d3ara1n/pi-chat-room

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-chat-room)](https://www.npmjs.com/package/@d3ara1n/pi-chat-room) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-chat-room)](https://www.npmjs.com/package/@d3ara1n/pi-chat-room) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-chat-room)](https://www.npmjs.com/package/@d3ara1n/pi-chat-room)

Agent-to-agent messaging for [pi](https://github.com/earendil-works/pi) — built on [`@d3ara1n/pi-mesh`](../pi-mesh). Exposes the `send_to` tool so agents can message each other; incoming messages arrive as user messages prefixed `[From: NAME]`.

Role-agnostic and order-agnostic: it doesn't know "assistant" or "director" — it just delivers messages between named peers. Roles are declared via pi-mesh's `mesh_set_profile`.

## How it works

- **Send**: the `send_to` tool resolves a peer by name and delivers a message over the mesh. Asynchronous — returns once the recipient's mesh acknowledges receipt, NOT when the recipient agent reads or replies. Replies arrive later as their own `[From: ...]` user messages.
- **Receive**: incoming messages are injected as user messages (`[From: NAME] ...`), delivered per the `chatRoom.deliveryMode` setting — `"steer"` (default) injects them at the next safe point while the agent is mid-turn; `"followUp"` queues them until the agent finishes its turn, then starts a new turn.
- **Output dual-channel**: an agent's normal output goes to the human user; addressing another agent REQUIRES `send_to`. This is enforced via `promptGuidelines`, since LLMs have no native notion of routing output to one audience vs another.

## Tool

### `send_to`

Send a message to another pi instance on the mesh.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | yes | Recipient's mesh name (from `mesh_list`). |
| `message` | yes | The message body. |

## Configuration

Delivery of incoming messages is controlled by the `chatRoom` settings block:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `deliveryMode` | `"steer"` \| `"followUp"` | `"steer"` | How incoming messages are injected. `"steer"` (default) delivers at the next safe point while the agent is mid-turn, so replies arrive as early as possible. `"followUp"` waits until the agent finishes its turn, then starts a new turn — never interrupts in-flight work. |

```jsonc
// ~/.pi/agent/settings.json
{
  "chatRoom": {
    "deliveryMode": "followUp"
  }
}
```

A project-level `.pi/settings.json` `chatRoom` block replaces the global block entirely.

## Installation

```bash
pi install npm:@d3ara1n/pi-mesh
pi install npm:@d3ara1n/pi-chat-room
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-mesh",
    "/absolute/path/to/pi-extensions/packages/pi-chat-room"
  ]
}
```

## Dependencies

- [`@d3ara1n/pi-mesh`](../pi-mesh) — peer discovery + transport

## License

MIT
