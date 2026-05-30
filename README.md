# Pi Extensions Monorepo

A collection of small extensions for [Pi Coding Agent](https://pi.dev).

## Extensions

| Package | Description |
|---------|-------------|
| [`context-include`](./packages/context-include) | `@path` syntax for AGENTS.md — include files by reference |

## Install

```bash
pi install npm:@d3ara1n/context-include
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

Scope must match the package directory name (e.g. `context-include`).
