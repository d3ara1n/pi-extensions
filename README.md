# Pi Extensions

A collection of small extensions for [Pi Coding Agent](https://pi.dev).

## Extensions

| Package | Description |
|---------|-------------|
| [`context-include`](./packages/context-include) | `@path` syntax for AGENTS.md — include files by reference |

## Install

Each extension can be installed individually:

```bash
pi install npm:@d3ara1n/context-include
```

Or install all at once:

```bash
pi install npm:@d3ara1n/context-include
```

## Development

```bash
npm install          # install all workspace dependencies
npm test             # run tests across all packages
```

## Publish

```bash
npm run publish --workspaces
```

## Publish

```bash
node publish.js context-include           # auto patch bump
node publish.js context-include minor     # bump minor
node publish.js context-include major     # bump major
```
