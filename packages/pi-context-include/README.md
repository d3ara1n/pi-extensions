# @d3ara1n/pi-context-include

`@path` syntax for AGENTS.md — include files by reference.

## Features

- **Relative paths**: `@CODEGRAPH.md`, `@./docs/rules.md`, `@../shared/AGENTS.md`
- **Absolute paths**: `@/absolute/path/to/file.md`
- **Home directory**: `@~/.agents/CODEGRAPH.md`
- **Recursive includes**: included files can themselves contain `@` references
- **Cycle detection**: prevents infinite include loops
- **Size guard**: 500KB total limit, 10 levels deep

## Install

```bash
pi install npm:@d3ara1n/pi-context-include
```

## Usage

In any AGENTS.md file:

```markdown
# Project Rules

@./docs/api-conventions.md
@~/.agents/CODEGRAPH.md
```

On each turn, the extension reads the referenced files and injects their content into the system prompt.

## Supported file types

`.md`, `.txt`, `.yaml`, `.yml`, `.json`, `.toml`
