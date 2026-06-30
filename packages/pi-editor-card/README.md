# pi-editor-card

Card/panel-style frame around the pi input editor — a rounded-corner box drawn with box-drawing glyphs (`╭╮││╰╯`), with status info embedded in the border. No Nerd Font required for the frame itself.

## What shows up where

- **Top border** — ` model · thinking-level ` (left) + pinned extension statuses (right, via `pinnedStatus` config)
- **Bottom border** — ` ctx NN%/NNNk · cache-tokens ` (left) + ` ~current/dir (branch) ` (right, includes git branch when available)
- **Below card** — Auto-wrapping extension status line (all `setStatus` entries not pinned to the top)
- **Border color** follows pi's thinking-level / bash-mode indicator automatically.

All segments are re-read from live session state on every paint, so switching thinking level or burning context updates the frame on the next render with no extra wiring.

## Configuration

In `~/.pi/agent/settings.json` under the `editorCard` key:

```jsonc
{
  "editorCard": {
    // Status keys to pin to the top-right corner of the card.
    // Only keys set via ctx.ui.setStatus() are eligible.
    "pinnedStatus": ["subagent", "access-denied"]
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/editor-card:status` | Show debug info: pinned config, all extension statuses with their keys, cache totals |

## How it works

The default pi editor only draws a horizontal line above and below the input area (no side borders). This extension wraps the built-in `CustomEditor`, renders it at `width - 2`, then wraps every line with left/right glyphs so the total width is unchanged. Border color follows pi's `borderColor` (which encodes thinking level / bash mode), so the frame stays semantically consistent and reacts to theme changes automatically.

## Installation

Add the package directory to the `extensions` array in `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-editor-card"
  ]
}
```

Then run `/reload` or restart pi.

## Caveats

- **Mutually exclusive** with other editor-replacing extensions (`border-status-editor`, `rainbow-editor`, `modal-editor`, …). Disable those when enabling this one — `setEditorComponent` is last-writer-wins.
- When the content scrolls, pi's native `↑ N more` / `↓ N more` indicators are replaced by the embedded status text (status takes precedence).
- Falls back to the default editor below `MIN_WIDTH` (20 columns).

## Dependencies

- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)
