# pi-editor-shell

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-editor-shell)](https://www.npmjs.com/package/@d3ara1n/pi-editor-shell) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-editor-shell)](https://www.npmjs.com/package/@d3ara1n/pi-editor-shell) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-editor-shell)](https://www.npmjs.com/package/@d3ara1n/pi-editor-shell)

Replaces pi's default editor and status bar with a unified rounded-corner shell drawn with box-drawing glyphs (`╭╮││╰╯`), with status info embedded in the border. The frame and spinner use only standard Unicode; the six border icons are Nerd Font glyphs (overridable — see [Configuration](#configuration)).

## What shows up where

- **Top border** — `  model ·  thinking-level ` (left) + pinned extension statuses (right, via `pinnedStatus` config)
- **Bottom border** — `  ctx NN%/NNk|N.NM · ⚡ cacheRead (total)  hitRate% · NN.N t/s · $N.NNN ` (left) + `  ~/Projects (main +2 ~1 *4) ` (right, shows git branch plus staged, unstaged, and untracked file counts when in a repo). TPS is client-observed visible-text throughput for the latest reliable completed response: `(visible output tokens - 1) / (last text delta - first text delta)`, excluding time-to-first-token and provider-reported reasoning tokens. Responses containing tool calls, failed/aborted responses, samples below 10 visible tokens, and samples shorter than 250 ms do not replace the last valid TPS. Providers without a reasoning-token breakdown may still include hidden reasoning in the count. Session cost includes assistant, tool, compaction, and branch-summary usage; the dollar segment is hidden when the provider reports no priced usage. Session hit rate via `/editor-shell:status`.
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

### Model display

How the model is labeled in the top-left border (`"name"` by default):

```json
{
  "editorShell": {
    "modelDisplay": "name"
  }
}
```

| Value | Example |
|-------|---------|
| `"name"` (default) | `Claude Opus 4.8` |
| `"provider-id"` | `anthropic/claude-opus-4-8` |

`"name"` uses `model.name`; a model with no name falls back to its id, so the slot never goes blank.

## Commands

| Command | Description |
|---------|-------------|
| `/editor-shell:status` | Show debug info: pinned config, all extension statuses with their keys, cache totals, latest reliable visible-text TPS, and session cost |

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

None.
