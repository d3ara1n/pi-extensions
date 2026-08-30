# Pi Extensions Monorepo

A collection of small extensions for [Pi Coding Agent](https://pi.dev).

## Extensions

| Package | Version | Description |
|---------|---------|-------------|
| [`@d3ara1n/pi-ask-user`](./packages/pi-ask-user) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-ask-user)](https://www.npmjs.com/package/@d3ara1n/pi-ask-user) | Collapsible ask-user tool — panel renders in the bottom editor slot (not a screen overlay), so the transcript stays visible and scrollable above it |
| [`@d3ara1n/pi-context-include`](./packages/pi-context-include) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-context-include)](https://www.npmjs.com/package/@d3ara1n/pi-context-include) | `@path` syntax for AGENTS.md — include files by reference, with a path safety fence (allow/deny roots, safe by default) |
| [`@d3ara1n/pi-hashline-edit`](./packages/pi-hashline-edit) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-hashline-edit)](https://www.npmjs.com/package/@d3ara1n/pi-hashline-edit) | Hashline-style file editing — line-anchored edits verified by content hash, replacing oldText/newText matching |
| [`@d3ara1n/pi-provider-agnes`](./packages/pi-provider-agnes) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-provider-agnes)](https://www.npmjs.com/package/@d3ara1n/pi-provider-agnes) | Agnes AI provider — token-billing + token-plan variants sharing the same text models |
| [`@d3ara1n/pi-provider-sensenova`](./packages/pi-provider-sensenova) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-provider-sensenova)](https://www.npmjs.com/package/@d3ara1n/pi-provider-sensenova) | SenseNova (商汤日日新) Token Plan provider — chat models via OpenAI-compatible API |
| [`@d3ara1n/pi-provider-stepfun`](./packages/pi-provider-stepfun) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-provider-stepfun)](https://www.npmjs.com/package/@d3ara1n/pi-provider-stepfun) | StepFun (阶跃星辰) provider — pay-as-you-go + Step Plan channels via OpenAI-compatible API |
| [`@d3ara1n/pi-usage-block`](./packages/pi-usage-block) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-usage-block)](https://www.npmjs.com/package/@d3ara1n/pi-usage-block) | Usage quota status block for powerline and pi-editor-shell |
| [`@d3ara1n/pi-editor-shell`](./packages/pi-editor-shell) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-editor-shell)](https://www.npmjs.com/package/@d3ara1n/pi-editor-shell) | Unified rounded-corner editor shell — embeds model, context, cache, git, and pinned extension status info in the editor border |
| [`@d3ara1n/pi-scout`](./packages/pi-scout) <sup>†</sup> | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-scout)](https://www.npmjs.com/package/@d3ara1n/pi-scout) | Per-turn side agent — lazy skill injection, automatic model routing, and trivial-ack short-circuit (skips the side model on `好的`/`ok`/`はい`) |
| [`@d3ara1n/pi-subagent`](./packages/pi-subagent) <sup>†</sup> | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-subagent)](https://www.npmjs.com/package/@d3ara1n/pi-subagent) | Role-based subagent orchestration — foreground and background (async `subagent_wait`/`subagent_check`, cancellable via `subagent_cancel`) delegation to specialized pi child processes with real-time TUI progress |
| [`@d3ara1n/pi-model-roles`](./packages/pi-model-roles) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-model-roles)](https://www.npmjs.com/package/@d3ara1n/pi-model-roles) | Named model role definitions with resolution to Model instances |
| [`@d3ara1n/pi-command-palette`](./packages/pi-command-palette) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-command-palette)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette) | Global command palette — Ctrl+Shift+P to search and run commands from anywhere |
| [`@d3ara1n/pi-session-namer`](./packages/pi-session-namer) <sup>†</sup> | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-session-namer)](https://www.npmjs.com/package/@d3ara1n/pi-session-namer) | Auto-name sessions using a cheap side agent |
| [`@d3ara1n/pi-access-denied`](./packages/pi-access-denied) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-access-denied)](https://www.npmjs.com/package/@d3ara1n/pi-access-denied) | Sandbox `write`/`edit`/`bash` to the project dir — prompt / deny / allow modes with per-session allow-deny memory |
| [`@d3ara1n/pi-mesh`](./packages/pi-mesh) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-mesh)](https://www.npmjs.com/package/@d3ara1n/pi-mesh) | Agent mesh — peer discovery + cross-instance transport; the neutral foundation `pi-peek-agent` and `pi-chat-room` build on |
| [`@d3ara1n/pi-peek`](./packages/pi-peek) <sup>†</sup> | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-peek)](https://www.npmjs.com/package/@d3ara1n/pi-peek) | Core consult engine — hooks that track the main agent's turns and power the utility-model investigate backend; consumed by `pi-peek-user` and `pi-peek-agent` |
| [`@d3ara1n/pi-peek-user`](./packages/pi-peek-user) <sup>‡</sup> | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-peek-user)](https://www.npmjs.com/package/@d3ara1n/pi-peek-user) | `/peek` overlay — ask your own session a question via the utility model, read-after-burn (never disturbs the main agent) |
| [`@d3ara1n/pi-peek-agent`](./packages/pi-peek-agent) <sup>§</sup><sup>‡</sup> | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-peek-agent)](https://www.npmjs.com/package/@d3ara1n/pi-peek-agent) | Cross-instance peek — `peek` tool over the pi-mesh transport; ask another pi instance without disturbing it |
| [`@d3ara1n/pi-chat-room`](./packages/pi-chat-room) <sup>§</sup> | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-chat-room)](https://www.npmjs.com/package/@d3ara1n/pi-chat-room) | Agent-to-agent messaging — `send_to` tool; incoming messages arrive as `[From: NAME]` user messages |

> <sup>†</sup> Requires [`pi-model-roles`](./packages/pi-model-roles) installed; <sup>‡</sup> requires [`pi-peek`](./packages/pi-peek) installed (which itself requires `pi-model-roles`); <sup>§</sup> requires [`pi-mesh`](./packages/pi-mesh) installed.

## Libraries

Pure npm packages — no `pi.extensions` entry point, no hooks/tools/commands. Import them in your own plugins.

| Package | Version | Description |
|---------|---------|-------------|
| [`@d3ara1n/pi-usage-block-core`](./packages/pi-usage-block-core) | [![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-usage-block-core)](https://www.npmjs.com/package/@d3ara1n/pi-usage-block-core) | Shared types and singleton registry for usage quota reporting |

## ACP / headless support

All extensions here work in [ACP](https://agentclientprotocol.com) hosts (e.g. Zed via `pi-acp`) and other non-TUI pi sessions (`--mode rpc`, print, JSON). Tool results are plain text, which every session mode shares; the rich TUI renderers only load in terminal sessions and are simply absent elsewhere.

Current state:

- **Interactive degradation** — `pi-access-denied` and `pi-ask-user` fall back to `select`/`confirm` dialogs through pi's extension UI sub-protocol when a host can answer them, with the JSON result contract kept identical to the TUI panels. See each package's "Non-TUI sessions" section for what carries over and what doesn't.
- **Works as-is** — `pi-scout`'s pending indicator (`setWidget` with string lines), `pi-usage-block`'s status entries, and `pi-subagent`'s live progress streaming all ride fire-and-forget or text channels that RPC mode supports natively; subagents themselves run as independent child processes regardless of parent mode.
- **Terminal-only by nature** — `pi-editor-shell`'s editor chrome no-ops outside a real terminal. The `pi-command-palette` and `pi-peek-user` overlays are command-entry UI; current ACP adapters don't forward extension slash commands at all, so they're simply unreachable rather than broken.

## Installation

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
