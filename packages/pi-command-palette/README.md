# pi-command-palette

Global command palette for [Pi Coding Agent](https://pi.dev) — press **Ctrl+Shift+P** to search and run commands from anywhere.

## Why?

Pi's slash commands (`/model`, `/compact`, extension commands, etc.) only work when the editor is empty. If you've typed something and want to switch models or run a command, you're stuck. This extension opens a floating command palette via keyboard shortcut, regardless of editor state.

## Dependencies

None.

## Installation

```bash
pi install npm:@d3ara1n/pi-command-palette
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-command-palette"
  ]
}
```

## Usage

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+P` _(default, configurable)_ | Open command palette |

The palette lists:

- **Built-in actions** — Model selector, New session, Compact, Reload, Fork, Tree, Resume
- **Extension commands** — All registered `/command` entries
- **Skills & Templates** — Skill commands and prompt templates

### Editor text preservation

When a command replaces your current editor text, the original content is saved and a **Restore: Previous Editor Text** entry appears at the top of the palette. Select it to get your text back.

### Model selector

The "Model: Switch Model" action opens a secondary overlay listing all models with configured API keys. Select one to switch instantly — no need to go through `/model` or `Ctrl+P`.

**Scoped models float to the top**, marked with a ★ (favorite) prefix. "Scoped" here means the same set pi uses for its built-in selector's scoped tab and `Ctrl+P` cycling — the `enabledModels` patterns in your `settings.json` (project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`). Everything else follows alphabetically. If no scope is configured, the list is a plain alphabetical roster — nothing breaks.

## Configuration

The default shortcut is `Ctrl+Shift+P`. If it conflicts with your terminal, override it via either of the following (evaluated in order, first match wins).

### 1. Environment variable

Useful for terminals that intercept `Ctrl+Shift+<key>` before it reaches the session (e.g. Termius on Windows/WSL2):

```bash
export PI_COMMAND_PALETTE_KEY=ctrl+alt+k
```

Add it to your shell profile to persist (`~/.zshrc` on macOS, `~/.bashrc` on bash).

### 2. settings.json

Set `commandPalette.shortcut` in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` in your project (project overrides global):

```jsonc
{
  "commandPalette": {
    "shortcut": "ctrl+alt+k"
  }
}
```

Any valid pi keybinding string works (e.g. `ctrl+shift+k`, `ctrl+alt+p`, `ctrl+k`). Restart pi (or run `/reload`) after changing the shortcut.
