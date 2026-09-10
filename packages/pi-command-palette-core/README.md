# @d3ara1n/pi-command-palette-core

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-command-palette-core)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette-core) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-command-palette-core)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette-core) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-command-palette-core)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette-core)

Shared types and singleton registry for [pi-command-palette](../pi-command-palette) — let any extension add **native** palette entries that run a callback directly.

Pi slash commands only run when the editor is empty, and the palette's `/command` entries work by filling the editor — both clobber whatever the user was typing. A native entry instead invokes your callback immediately: no editor round-trip, no text saved or restored, works mid-draft.

## Dependencies

None.

## Installation

```bash
npm install @d3ara1n/pi-command-palette-core
```

> This package is a **library**, not a standalone pi extension. It is installed automatically when used by another plugin; install it directly only when building against its API. Entries registered here only appear in the UI when [`@d3ara1n/pi-command-palette`](../pi-command-palette) is installed and loaded.

## Registering a palette command

From your extension's factory body (re-runs on every load/reload, overwriting by id):

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";

export default function myExtension(pi: ExtensionAPI) {
  paletteCommandRegistry.register({
    id: "my-plugin:do-thing",
    label: "My Plugin: Do the Thing",
    description: "Runs immediately, without touching the editor",
    run: (pi, ctx) => ctx.ui.notify("Done", "info"),
  });
}
```

Native entries appear in the palette after the built-in actions and above the `/command` entries, and are re-read every time the palette opens — register and unregister at any time. Rejections from `run` are caught by the palette and surfaced as an error notification.

## Types

### `PaletteCommand`

```ts
interface PaletteCommand {
  id: string;          // unique; namespaced ids ("plugin:action") avoid collisions
  label: string;       // shown in the palette; prefix with the plugin name
  description?: string; // one line, shown under the label
  run(pi: ExtensionAPI, ctx: ExtensionContext): void | Promise<void>;
}
```

`run` receives the palette extension's live `ExtensionAPI` and the shortcut handler's `ExtensionContext` (the palette is opened via keyboard shortcut, so `ctx` is an `ExtensionContext`, not an `ExtensionCommandContext` — session-control methods like `newSession`/`fork`/`reload` are not on it).

## Registry

`paletteCommandRegistry` is a global singleton shared across all extensions via `globalThis`:

```ts
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";

paletteCommandRegistry.register(command: PaletteCommand): void; // overwrites if id exists
paletteCommandRegistry.unregister(id: string): void;
paletteCommandRegistry.get(id: string): PaletteCommand | undefined;
paletteCommandRegistry.getAll(): PaletteCommand[];               // registration order
paletteCommandRegistry.size: number;
```

## Why a separate package?

Pi extensions can load the same package under distinct module identities. Storing this registry on `globalThis` keeps registrants and the palette connected across those identities and reloads.
