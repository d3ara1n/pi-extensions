# Pi Extensions Monorepo

A collection of small extensions for [Pi Coding Agent](https://pi.dev).

## Extensions

| Package | Description |
|---------|-------------|
| [`pi-ask-user`](./packages/pi-ask-user) | Collapsible ask-user tool — panel renders in the bottom editor slot (not a screen overlay), so the transcript stays visible and scrollable above it |
| [`pi-context-include`](./packages/pi-context-include) | `@path` syntax for AGENTS.md — include files by reference |
| [`pi-provider-zhipu-coding-plan`](./packages/pi-provider-zhipu-coding-plan) | Zhipu AI Coding Plan provider — auto-discover models, report usage |
| [`pi-usage-block`](./packages/pi-usage-block) | Usage quota status bar block for powerline |
| [`pi-scout`](./packages/pi-scout) <sup>†</sup> | Per-turn side agent — lazy skill injection + automatic model routing |
| [`pi-subagent`](./packages/pi-subagent) <sup>†</sup> | Role-based subagent orchestration — delegates tasks to specialized pi child processes with real-time TUI progress |
| [`pi-model-roles`](./packages/pi-model-roles) | Named model role definitions with resolution to Model instances |
| [`pi-command-palette`](./packages/pi-command-palette) | Global command palette — Ctrl+Shift+P to search and run commands from anywhere |
| [`pi-session-namer`](./packages/pi-session-namer) <sup>†</sup> | Auto-name sessions using a cheap side agent |
| [`pi-access-denied`](./packages/pi-access-denied) | Sandbox `write`/`edit`/`bash` to the project dir — prompt / deny / allow modes with per-session allow-deny memory |
| [`pi-peek`](./packages/pi-peek) <sup>†</sup> | Core consult engine — hooks that track the main agent's turns and power the utility-model investigate backend; consumed by `pi-peek-user` and `pi-peek-agent` |
| [`pi-peek-user`](./packages/pi-peek-user) <sup>‡</sup> | `/peek` overlay — ask your own session a question via the utility model, read-after-burn (never disturbs the main agent) |
| [`pi-peek-agent`](./packages/pi-peek-agent) <sup>‡</sup> | Cross-instance peek — `peek`/`peek_list` tools over a zero-dep Unix domain socket mesh; ask another pi instance without disturbing it |

> <sup>†</sup> Requires [`pi-model-roles`](./packages/pi-model-roles) in `extensions` &emsp; <sup>‡</sup> Requires [`pi-peek`](./packages/pi-peek) in `extensions`

## Libraries

Pure npm packages — no `pi.extensions` entry point, no hooks/tools/commands. Import them in your own plugins.

| Package | Description |
|---------|-------------|
| [`pi-usage-block-core`](./packages/pi-usage-block-core) | Shared types and singleton registry for usage quota reporting |

## Install

```bash
pi install npm:@d3ara1n/pi-context-include
```

## Development

```bash
npm install
```

## Publish

Fully automated via GitHub Actions on push to `main`.

Uses [Conventional Commits](https://www.conventionalcommits.org/):

| Commit | Version bump |
|--------|-------------|
| `feat(<scope>): ...` | minor |
| `fix(<scope>): ...` | patch |
| `feat(<scope>)!: ...` or `BREAKING CHANGE:` | major |
| `chore:`, `docs:`, `refactor:` | no publish |

Scope must match the package directory name (e.g. `pi-context-include`).
