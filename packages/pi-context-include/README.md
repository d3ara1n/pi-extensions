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

## Install

```bash
pi install npm:@d3ara1n/pi-context-include
```

## Dependencies

- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — peer dependency, provided by the pi runtime

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

Optional, in `~/.pi/agent/settings.json` under `contextInclude`:

```jsonc
{
  "contextInclude": {
    "maxDepth": 15,     // default: 10
    "maxBytes": 1000000  // default: 500000 (500KB)
  }
}
```

## Command

`/context-include:status` — shows current configuration and limits.
