# pi-editor-shell

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-editor-shell)](https://www.npmjs.com/package/@d3ara1n/pi-editor-shell) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-editor-shell)](https://www.npmjs.com/package/@d3ara1n/pi-editor-shell) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-editor-shell)](https://www.npmjs.com/package/@d3ara1n/pi-editor-shell)

Replaces pi's default editor and status bar with a unified rounded-corner shell drawn with box-drawing glyphs (`╭╮││╰╯`), with status info embedded in the border. The frame and spinner use only standard Unicode; border icons use Nerd Font glyphs or standard Unicode symbols and are overridable — see [Configuration](#configuration).

## What shows up where

- **Top border** — ` activity ·  model ·  thinking-level ` (left) + pinned extension statuses (right, via `pinnedStatus` config). The activity indicator shows a phase-aware spinner while working and ` Nm` while idle — see [Activity indicator](#activity-indicator).
- **Bottom border** — `  ctx NN%/NNk|N.NM · ⚡cacheRead(total)  hitRate% · NN.N e2e t/s · $N.NNN ·  N ` (left) + `  ~/Projects (main +2 ~1 *4) ` (right, shows git branch plus staged, unstaged, and untracked file counts when in a repo; inside a linked worktree the branch carries an `@<name>` tag, e.g. `(feature-x @feature-x +2 ~1)`, so sibling worktrees of one repo are told apart at a glance). Response throughput defaults to client-observed end-to-end visible-text throughput, including local request preparation, network and queue latency, hidden reasoning, and visible generation. It can instead show generation throughput or be hidden; see [Throughput display](#throughput-display). A new turn clears the previous measurement, so unavailable samples never leave stale data in the border. Session cost includes assistant, tool, compaction, and branch-summary usage; the dollar segment is hidden when the provider reports no priced usage. ` N` counts persisted user messages on the current session branch. Session hit rate and detailed response timing are available via `/editor-shell:status`.
- **Below shell** — Auto-wrapping extension status line (all `setStatus` entries not pinned to the top)
- **Border color** follows pi's thinking-level / bash-mode indicator automatically.

All segments are re-read from live session state on every paint, so switching thinking level or burning context updates the frame on the next render with no extra wiring. The activity indicator precedes the model label; its width follows its content.

## Configuration

In `~/.pi/agent/settings.json` under the `editorShell` key:

```json
{
  "editorShell": {
    "pinnedStatus": ["subagent", "access-denied"],
    "tpsDisplay": "end-to-end",
    "icons": {
      "model": "robot",
      "cache": "\\uf0e7"
    }
  }
}
```

### Default icons

| Slot | Glyph | Icon source |
|------|-------|-------------|
| `model` | `` | oct-cpu |
| `thinking` | `` | oct-light_bulb |
| `context` | `` | oct-cache |
| `cache` | `⚡` | oct-zap |
| `hitRate` | `` | fa-bullseye |
| `turn` | `` | oct-comment_discussion |
| `timer` | `` | oct-clock |
| `folder` | `` | fa-folder_open |

### Branch counter

The ` N` segment counts persisted user messages on the current session branch. Tool loops do not increase it, while steering and follow-up prompts count when they enter the branch. The value is rebuilt from branch history, so restored sessions, edited history, and branch switches show the correct branch-local count. Like the other optional stats, the segment stays hidden while the count is zero — a fresh session shows no counter.

### Activity indicator

The first segment of the top border shows the session's activity:

- **Working** — a spinner follows the current phase: thinking, outputting, tool-call generation, or tool execution. Its color follows the border.
- **Idle** — ` Nm` counts whole minutes since the full agent run settled, including any automatic retries or queued continuations. It starts at `0m`; `4m` covers 4:00 through 4:59.
- **Fresh session** — the segment and its separator stay hidden until the first run starts.

A restored session seeds idle time from its newest conversational entry timestamp; bootstrap and bookkeeping entries do not count. One session-owned clock advances the spinner every 100 ms while working and checks idle time every second while idle. It repaints only when the displayed frame, minute, or color changes, and stays stopped before the first activity. Durations use wall-clock timestamps, so delayed ticks do not accumulate timing errors. Rebuilding the editor preserves the activity state and animation.

Idle text uses the theme's muted tone by default. When the current model declares a prompt-cache lifetime (`promptCache` in pi's model catalog, `PI_CACHE_RETENTION=long` selects the long tier), it turns amber within the last tenth of that lifetime and red past it as a cache-age hint. Models without a declared lifetime stay muted.

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

### Throughput display

Choose the response-throughput metric shown in the bottom border (`"end-to-end"` by default):

```json
{
  "editorShell": {
    "tpsDisplay": "end-to-end"
  }
}
```

| Value | Border label | Measurement |
|-------|--------------|-------------|
| `"end-to-end"` (default) | `e2e t/s` | Visible output tokens divided by total turn duration, including wait time and hidden reasoning |
| `"generation"` | `gen t/s` | Visible tokens after the first divided by the time from first visible text to response completion |
| `"none"` | — | Hides response throughput from the border |

Both throughput values, time to first visible text, total response time, visible-token count, and token source remain available via `/editor-shell:status`. Generation samples below 10 visible tokens or 250 ms are reported as unavailable. Responses containing tool calls cannot provide a portable text-token split. If reasoning is active but the provider does not supply a usable positive reasoning-token count, both throughput values are reported as unavailable rather than treating hidden tokens as visible output.

## Commands

| Command | Description |
|---------|-------------|
| `/editor-shell:status` | Show debug info: config, extension statuses, cache totals, response wait time, end-to-end and generation throughput, token source, and session cost |

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
- The custom shell and its activity clock run only in TUI mode; RPC, print, and JSON modes retain their host UI.

## Dependencies

None.
