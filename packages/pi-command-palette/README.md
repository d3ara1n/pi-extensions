# pi-command-palette

Global command palette for [Pi Coding Agent](https://pi.dev) — press **Ctrl+Shift+P** to search and run commands from anywhere.

## Why?

Pi's slash commands (`/model`, `/compact`, extension commands, etc.) only work when the editor is empty. If you've typed something and want to switch models or run a command, you're stuck. This extension opens a floating command palette via keyboard shortcut, regardless of editor state.

## Install

```bash
pi install npm:@d3ara1n/pi-command-palette
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-command-palette"]
}
```

## Usage

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+P` | Open command palette |

The palette lists:

- **Built-in actions** — Model selector, New session, Compact, Reload, Fork, Tree, Resume
- **Extension commands** — All registered `/command` entries
- **Skills & Templates** — Skill commands and prompt templates

### Editor text preservation

When a command replaces your current editor text, the original content is saved and a **Restore: Previous Editor Text** entry appears at the top of the palette. Select it to get your text back.

### Model selector

The "Model: Switch Model" action opens a secondary overlay listing all models with configured API keys. Select one to switch instantly — no need to go through `/model` or `Ctrl+P`.

## Configuration

No configuration needed. Works out of the box.
