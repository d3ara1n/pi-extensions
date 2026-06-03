# Pi Extensions Monorepo

A collection of small extensions for [Pi Coding Agent](https://pi.dev).

## Extensions

| Package | Description |
|---------|-------------|
| [`pi-context-include`](./packages/pi-context-include) | `@path` syntax for AGENTS.md — include files by reference |
| [`pi-provider-zhipu-coding-plan`](./packages/pi-provider-zhipu-coding-plan) | Zhipu AI Coding Plan provider — auto-discover models, report usage |
| [`pi-usage-block`](./packages/pi-usage-block) | Usage quota status bar block for powerline |

## Libraries

| Package | Description |
|---------|-------------|
| [`pi-usage-block-core`](./packages/pi-usage-block-core) | Shared types and registry for usage quota reporting |

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
