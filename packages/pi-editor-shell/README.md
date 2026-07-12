# pi-editor-shell

Replaces pi's default editor and status bar with a unified rounded-corner shell drawn with box-drawing glyphs (`╭╮││╰╯`), with status info embedded in the border. The frame and spinner use only standard Unicode; the six border icons are Nerd Font glyphs (overridable — see [Configuration](#configuration)).

## What shows up where

- **Top border** — `  provider/model ·  thinking-level ` (left) + pinned extension statuses (right, via `pinnedStatus` config)
- **Bottom border** — `  ctx NN%/NNk|N.NM · ⚡ cacheRead (total)  hitRate% ` (left) + `  ~/Projects (main +2 ~1) ` (right, shows git branch + dirty state when in a repo)
- **Below shell** — Auto-wrapping extension status line (all `setStatus` entries not pinned to the top)
- **Border color** follows pi's thinking-level / bash-mode indicator automatically.

All segments are re-read from live session state on every paint, so switching thinking level or burning context updates the frame on the next render with no extra wiring. When the agent is active, the current phase spinner (thinking/outputting/toolcall/exec) replaces the model text in the top-left slot.

## Configuration

In `~/.pi/agent/settings.json` under the `editorShell` key:

```json
{
  "editorShell": {
    "pinnedStatus": ["subagent", "access-denied"],
    "icons": {
      "model": "robot",
      "cache": "\\uf0e7"
    }
  }
}
```

### Default icons

| Slot | Glyph | Nerd Font name |
|------|-------|----------------|
| `model` | `` | oct-cpu |
| `thinking` | `` | oct-light_bulb |
| `context` | `` | oct-cache |
| `cache` | `⚡` | oct-zap |
| `hitRate` | `` | fa-bullseye |
| `folder` | `` | fa-folder_open |

## Commands

| Command | Description |
|---------|-------------|
| `/editor-shell:status` | Show debug info: pinned config, all extension statuses with their keys, cache totals |

## How it works

The default pi editor only draws a horizontal line above and below the input area (no side borders), and a separate footer renders the status bar. This extension replaces both — it wraps the built-in `CustomEditor`, renders it at `width - 2`, wraps every line with left/right glyphs, and embeds the status bar information (extension statuses) below the shell. The total width is unchanged. Border color follows pi's `borderColor` (which encodes thinking level / bash mode), so the shell stays semantically consistent and reacts to theme changes automatically.

When the autocomplete popup is open, the divider between editor content and popup items becomes a T-junction (`├─┤`) carrying the context/cwd info, closing everything into one connected card with two panes. Below `MIN_WIDTH` (20 columns), it falls back to the default editor.

## Installation

```bash
pi install npm:@d3ara1n/pi-editor-shell
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-editor-shell"
  ]
}
```

## Caveats

- **Mutually exclusive** with other editor-replacing extensions (`border-status-editor`, `rainbow-editor`, `modal-editor`, …). Disable those when enabling this one — `setEditorComponent` is last-writer-wins.
- When the content scrolls, pi's native `↑ N more` / `↓ N more` indicators are replaced by the embedded status text (status takes precedence).
- Falls back to the default editor below `MIN_WIDTH` (20 columns).

## Dependencies

- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)
