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

## Install

```bash
pi extension add @d3ara1n/pi-peek         # install first — provides the consult core
pi extension add @d3ara1n/pi-peek-user
```

Both must be in `settings.json` extensions — `pi-peek` provides the consult backend, `pi-peek-user` only registers the `/peek` command.

## Dependencies

- [`@d3ara1n/pi-peek`](../pi-peek) — consult core (tracker hooks + investigate backend)

## Usage

```
/peek
```

Type a question, press Enter. The answer streams in. Ask follow-ups, or press Esc to close.

## License

MIT
