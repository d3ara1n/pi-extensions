# @d3ara1n/pi-peek-user

`/peek` overlay for [pi](https://github.com/earendil-works/pi) — ask your own session a question without disturbing the main agent.

Opens a centered overlay that serializes the current conversation and streams an answer from the `utility` model (read-after-burn). The main agent keeps running, completely unaware.

```
╭──────────────────────────────────────────────────╮
│ peek (main agent: idle, turn 3)                  │
├──────────────────────────────────────────────────┤
│ you                                              │
│ how is the debounce implemented?                 │
│ peek                                             │
│ debounce uses requestAnimationFrame, cancelled   │
│ in the useEffect cleanup…                        │
├──────────────────────────────────────────────────┤
│ › ask anything about this session…               │
├──────────────────────────────────────────────────┤
│ model deepseek/deepseek-v4-flash   tokens 1.2k   │
├──────────────────────────────────────────────────┤
│ Esc close · Enter send                           │
╰──────────────────────────────────────────────────╯
```

## Features

- **Streaming** — the answer appears token-by-token as it arrives
- **Auto-height** — the message region grows with content up to ~80% of the terminal, then scrolls (↑/↓, auto-follows the tail while streaming)
- **Multi-turn** — follow-up questions reuse the serialized context (cheaper, no re-serialization)
- **Live status** — header shows what the main agent is doing right now; status line shows the utility model + cumulative tokens
- **Read-after-burn** — closing the overlay discards everything; the main session is never touched

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-peek
pi install npm:@d3ara1n/pi-peek-user
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-peek",
    "/absolute/path/to/pi-extensions/packages/pi-peek-user"
  ]
}
```

## Dependencies

- [`@d3ara1n/pi-peek`](../pi-peek) — consult core (tracker hooks + investigate backend)

## Usage

```
/peek
```

Type a question, press Enter. The answer streams in. Ask follow-ups, or press Esc to close.

## License

MIT
