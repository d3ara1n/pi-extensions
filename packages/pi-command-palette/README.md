# pi-command-palette

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-command-palette)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-command-palette)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-command-palette)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette)

Global command palette for [Pi Coding Agent](https://pi.dev) — press **Ctrl+Shift+P** to search and run commands from anywhere.

## Why?

Pi's slash commands (`/model`, `/compact`, extension commands, etc.) only work when the editor is empty. If you've typed something and want to switch models or run a command, you're stuck. This extension opens a floating command palette via keyboard shortcut, regardless of editor state.

## Dependencies

- [`@d3ara1n/pi-command-palette-core`](../pi-command-palette-core) — shared registry for native palette commands (pure npm library, installed automatically)

## Installation

```bash
pi install npm:@d3ara1n/pi-command-palette
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-command-palette"
  ]
}
```

## Usage

| Entry | Action |
|-------|--------|
| `Ctrl+Shift+P` _(default, configurable)_ | Open command palette |
| `/palette` | Open command palette — typed like any extension command; the shortcut dispatches this command internally |

The palette opens as a single macOS-launcher-style overlay with nested pages. The root page mixes leaves and sub-pages: built-in actions sit directly on the root, while Models, Sessions, Drafts, extension actions, commands, skills, and templates open as sub-pages; selecting one with **Enter** replaces the current list in the same overlay instead of opening a second overlay. Press **Backspace** with an empty search field to return to the parent page; press **Esc** to close the palette immediately. The palette requires TUI mode; other modes receive a notification.

The root page lists:

- **Built-in actions** — curated shortcuts for common operations, shown directly on the root page so urgent entries like Restore never hide behind a sub-page (detailed below)
- **Models** — a sub-page listing every model with a configured API key (see below)
- **Sessions** — a sub-page listing this project's sessions for one-key resume (see below)
- **Drafts (N)** — a sub-page of this session's saved editor text, newest first; search includes the full draft text
- **Extension Actions** — a sub-page of entries registered by other extensions that run a callback directly (see below)
- **Commands** / **Skills** / **Templates** — sub-pages for all registered `/command` entries, installed skills, and prompt templates; entries are labeled with their bare `/name` since the breadcrumb already names the category

Use **↑/↓** to move through entries and **←/→** to edit the search cursor. Search is fuzzy within the current page and updates as you type; searching the root page also matches entries from every sub-page, with each match's category shown next to its description. Backspace uses the normal text-editing behavior while the query is non-empty.

### Built-in actions

Built-in actions call pi's API directly — no editor round-trip, no extra Enter:

**Run immediately** — they call pi's API directly, no editor round-trip:

| Action | What it does |
|--------|--------------|
| Session: New | Start a new session right away via pi's session API |
| Session: Compact | Compact the conversation right away |
| Session: Reload | Reload extensions, skills, and config right away (blocked while the agent is streaming) |
| Editor: Copy Content | Copy current editor text to the clipboard |
| Editor: Save Draft | Save current editor text as a new draft, then clear the editor |
| Editor: Restore Latest Draft | Move the latest draft into the editor, saving any existing input as a new draft first _(appears only when drafts exist)_ |

> Pi ships with more built-in slash commands (e.g. `/export`, `/share`, `/name`, `/settings`). This palette only surfaces a curated subset above — for the rest, type them directly into the editor.

### Native commands from other extensions

Extensions built on [`@d3ara1n/pi-command-palette-core`](../pi-command-palette-core) can register palette entries backed by a **direct callback** instead of a `/command` editor fill. They appear above the extension-command entries, and selecting one runs the callback in place — your editor text is never touched, saved, or restored:

```ts
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";

paletteCommandRegistry.register({
  id: "my-plugin:do-thing",
  label: "My Plugin: Do the Thing",
  description: "Runs immediately, without touching the editor",
  run: (pi, ctx) => { /* ... */ },
});
```

The registry is read every time the palette opens, so commands can be registered and unregistered at any time. Failures inside `run` are caught and surfaced as an error notification. See the [core package](../pi-command-palette-core) for the full API.

### Drafts

Use **Editor: Save Draft** to set aside input while continuing the current conversation. When a palette command fills the editor, the existing text is also saved as a new draft. Multiple drafts are kept independently; saving another never overwrites earlier ones. Whitespace-only input is not saved.

**Editor: Restore Latest Draft** provides a direct root-menu shortcut. The **Drafts (N)** page lists all drafts, newest first, with a text preview, save time, and line count. Fuzzy search on this page or the root page matches the full text.

| Key | Action |
|-----|--------|
| Enter | Move the selected draft into the editor and close the palette |
| Ctrl+P | Preview the selected draft's full text without taking it out |
| Ctrl+D | Delete the selected draft |
| Backspace (empty search) | Return to the parent page |
| Esc | Close the palette |

The preview supports **↑/↓**, **Page Up/Page Down**, and **Home/End** scrolling. **Enter** restores it, **Ctrl+D** deletes it, and **Backspace** or **Ctrl+P** returns to the list.

Restoring removes the selected draft from the draft box. If the editor already contains text, that text becomes the newest draft in the same save operation. Nothing is sent automatically. After restoring, the text belongs to the editor; save it again to put it back in the draft box.

Drafts are stored at `~/.pi/command-palette/drafts/{sessionId}.json`, using the user's home directory and pi's `CONFIG_DIR_NAME` (`.pi`). This plugin data directory is independent of `PI_CODING_AGENT_DIR`, which redirects pi's agent directory. Each file contains only the current draft list. Save, restore, and delete atomically replace the file before updating the in-memory list or editor. A failed write leaves the editor and draft list unchanged. There is no shutdown save or per-keystroke persistence.

Drafts reload with their session and survive extension reloads and restarts. Navigating branches within that session does not rewind them; a new or forked session has its own draft box. Drafts are separate from the conversation log and are not added to model context. Deleting a session through pi does not automatically delete its separate draft file.

### Model selector

The "Models" entry opens a model page inside the same overlay. Models are loaded when the page is first entered, then can be searched and selected without stacking another overlay.

**Scoped models float to the top**, marked with a ★ (favorite) prefix. "Scoped" here means the same set pi uses for its built-in selector's scoped tab and `Ctrl+P` cycling — the `enabledModels` patterns in your `settings.json` (project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`). Everything else follows alphabetically. Filtering preserves that boundary too — scoped matches stay above the rest while you type, rather than collapsing into one score-ordered list. If no scope is configured, the list is a plain alphabetical roster — nothing breaks.

### Sessions

The "Sessions" entry opens a session page inside the same overlay — the palette equivalent of `/resume`. It lists the current project's sessions sorted by activity, showing each session's name (or first-message preview), relative time, and message count; the session you are in is marked `current`. Selecting an entry switches to it immediately via pi's session API — no editor round-trip.

The list loads lazily when the page is first entered and fills in progressively as sessions are read from disk, so the picker is usable before the full scan completes. The page is scoped to the current working directory, matching the project scope pi uses everywhere else; use `/resume` for the cross-project picker.

## Configuration

The default shortcut is `Ctrl+Shift+P`, matching VS Code's Command Palette for familiar muscle memory. If it conflicts with your terminal or other shortcuts, override it via either of the following (evaluated in order, first match wins).

### 1. Environment variable

Useful for terminals that intercept `Ctrl+Shift+<key>` before it reaches the session (e.g. Termius on Windows/WSL2):

```bash
export PI_COMMAND_PALETTE_KEY=ctrl+shift+p
```

Add it to your shell profile to persist (`~/.zshrc` on macOS, `~/.bashrc` on bash).

### 2. settings.json

Set `commandPalette.shortcut` in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` in your project. A present project `commandPalette` block replaces the global block:

```json
{
  "commandPalette": {
    "shortcut": "ctrl+shift+p"
  }
}
```

Any valid pi keybinding string works (e.g. `ctrl+shift+p`, `ctrl+shift+k`, `ctrl+alt+k`, `ctrl+k`). Restart pi (or run `/reload`) after changing the shortcut.
