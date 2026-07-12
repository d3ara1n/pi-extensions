# @d3ara1n/pi-context-include

`@path` syntax for AGENTS.md — include files by reference.

## Features

- **Line-start only**: `@path` must be at the start of a line (prevents false positives from emails/code)
- **Fenced block safe**: `@path` lines inside triple-backtick blocks are ignored
- **Relative paths**: `@CODEGRAPH.md`, `@./docs/rules.md`, `@../shared/AGENTS.md`
- **Absolute paths**: `@/absolute/path/to/file.md`
- **Home directory**: `@~/.agents/CODEGRAPH.md`
- **Recursive includes**: included files can themselves contain `@` references
- **Cycle detection**: prevents infinite include loops
- **Size guard**: 500KB total limit, 10 levels deep (configurable)

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
@~/.agents/CODEGRAPH.md
```

On each turn, the extension reads the referenced files and injects their content into the system prompt.

**Important:** `@path` must be at the start of a line (after trimming). It will not be recognized mid-sentence or inside code blocks.

## Supported file types

`.md`, `.txt`, `.yaml`, `.yml`, `.json`, `.toml`

## Configuration

Optional. Read from `~/.pi/agent/settings.json` (global), merged with
`{project}/.pi/settings.json` (project overrides global), under `contextInclude`.
`maxDepth` and `maxBytes` must be finite, non-negative numbers; invalid values
use the defaults. `maxBytes` is measured as UTF-8 bytes:

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

## Command

`/context-include:status` — shows current configuration, resolved includes, and
any files that were skipped (missing, empty, over size/depth limits, duplicates,
or unreadable). Run this to diagnose why a referenced file wasn't included.
