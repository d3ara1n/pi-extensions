# @d3ara1n/pi-context-include

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-context-include)](https://www.npmjs.com/package/@d3ara1n/pi-context-include) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-context-include)](https://www.npmjs.com/package/@d3ara1n/pi-context-include) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-context-include)](https://www.npmjs.com/package/@d3ara1n/pi-context-include)

`@path` syntax for AGENTS.md — include files by reference.

## Features

- **Line-start only**: `@path` sits at the start of a line, optionally after a Markdown list marker (`-`, `*`, `+`, or `1.`) — prevents false positives from emails/code
- **Fenced block safe**: `@path` lines inside triple-backtick blocks are ignored
- **Relative paths**: `@CODEGRAPH.md`, `@./docs/rules.md`, `@../shared/AGENTS.md`
- **Absolute paths**: `@/absolute/path/to/file.md`
- **Home directory**: `@~/.pi/agent/includes/shared-rules.md`
- **Recursive includes**: included files can themselves contain `@` references
- **Cycle detection**: prevents infinite include loops
- **Size guard**: 500KB total limit, 10 levels deep (configurable)
- **Path safety fence**: includes are confined to allowed roots; out-of-scope paths are blocked by default

## Installation

```bash
pi install npm:@d3ara1n/pi-context-include
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-context-include"
  ]
}
```

## Dependencies

None.

## Usage

In any AGENTS.md file:

```markdown
# Project Rules

@./docs/api-conventions.md
@~/.pi/agent/includes/team-conventions.md
```

On each turn, the extension reads the referenced files and injects their content into the system prompt.

**Important:** `@path` must be at the start of a line, optionally after a Markdown list marker (`-`/`*`/`+`/`1.`). It will not be recognized mid-sentence or inside code blocks.

## Supported file types

`.md` only. Structured formats (`.json`/`.yaml`/`.toml`) are intentionally excluded — they typically hold config or credentials, not instructions, and are better read on demand.

## Configuration

Optional. Read from `~/.pi/agent/settings.json` (global) or
`{project}/.pi/settings.json` (project). A present project `contextInclude`
block replaces the global block; omitted fields then use defaults. `maxDepth`
and `maxBytes` must be finite, non-negative numbers; invalid values use the
defaults. `maxBytes` is measured as UTF-8 bytes. Optional `allowedRoots` /
`deniedRoots` configure the [path safety fence](#path-safety-fence).

```json
{
  "contextInclude": {
    "maxDepth": 15,
    "maxBytes": 1000000
  }
}
```

Settings files must be valid JSON (no comments). Settings are loaded on
session start — run `/reload` or restart pi after editing.

### Path safety fence

Included files are injected into the system prompt inside pi's high-trust
`<project_instructions>` tag, so an accidental `@secrets.json` or
`@../sibling/secret.md` would leak secrets on every turn. Includes are
therefore confined to an **allow-set of roots**, with a **deny-set** that
always wins:

```json
{
  "contextInclude": {
    "allowedRoots": ["./docs", "~/.pi/agent/includes"],
    "deniedRoots": ["./secrets", "node_modules"]
  }
}
```

- `allowedRoots` — roots that may be included. Relative entries resolve
  against the **project root**. (This is separate from `@`-reference
  resolution: a `@path` inside an AGENTS.md still resolves relative to *that
  file*, as always.) An explicit `allowedRoots` **fully replaces** the
  defaults below; an empty array `[]` blocks everything.
- `deniedRoots` — roots that may never be included, always evaluated first
  and taking precedence over `allowedRoots`.

**Default allow-set** (used when `allowedRoots` is omitted, so existing
setups keep working):

- each context file's own directory tree (so in-repo `@docs/rules.md` works
  zero-config), and
- `~/.pi/agent/includes/` — a shared home for cross-repo rules.

Anything else (`@/etc/...`, `@../sibling/...`, `@~/credentials.json`) is
blocked by default and reported by `/context-include:status` as "outside
allowed roots".

The fence guards against accidents and misconfiguration, not adversaries —
anyone who can edit `settings.json` controls the policy.

## Command

`/context-include:status` — shows the effective allow/deny roots, resolved
includes, and any files that were skipped (missing, empty, over size/depth
limits, outside the allowed roots, denied by deniedRoots, duplicates, or
unreadable). Run this to diagnose why a referenced file wasn't included.
