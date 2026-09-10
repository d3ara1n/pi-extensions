/**
 * Shared types + registry for native command-palette entries.
 *
 * Pi slash commands only run when the editor is empty, and the palette's
 * `/command` entries work by filling the editor — both clobber whatever the
 * user was typing. A **native** palette entry instead runs a callback
 * directly: no editor round-trip, no text saved or restored, works mid-draft.
 *
 * Any extension can register entries here; [`@d3ara1n/pi-command-palette`](https://www.npmjs.com/package/@d3ara1n/pi-command-palette)
 * lists them above its `/command` entries and invokes {@link PaletteCommand.run}
 * with the live extension API and context when selected.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * A palette entry backed by a direct callback.
 *
 * Register from an extension factory body (re-runs on every load/reload,
 * overwriting by id):
 *
 * ```ts
 * import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";
 *
 * export default function myExtension(pi: ExtensionAPI) {
 *   paletteCommandRegistry.register({
 *     id: "my-plugin:do-thing",
 *     label: "My Plugin: Do the Thing",
 *     description: "Runs immediately, without touching the editor",
 *     run: (pi, ctx) => ctx.ui.notify("Done", "info"),
 *   });
 * }
 * ```
 */
export interface PaletteCommand {
  /**
   * Unique identifier. Namespaced ids (`"plugin:action"`) avoid collisions;
   * re-registering the same id overwrites the previous entry.
   */
  id: string;
  /** Label shown in the palette. Prefix it with the plugin name for scannability. */
  label: string;
  /** Optional one-line description shown under the label. */
  description?: string;
  /**
   * Execute when the user selects this entry. Called with the palette
   * extension's live {@link ExtensionAPI} and the shortcut handler's
   * {@link ExtensionContext}. Rejections are caught by the palette and
   * surfaced as an error notification — throwing is a safe way to fail.
   */
  run(pi: ExtensionAPI, ctx: ExtensionContext): void | Promise<void>;
}

/**
 * Global singleton registry for native palette commands.
 *
 * Shared across all pi extensions through globalThis, which avoids duplicate
 * registries when the same package is loaded under different module identities.
 */
export class PaletteCommandRegistry {
  private commands = new Map<string, PaletteCommand>();

  /** Register a palette command. Overwrites if id already exists. */
  register(command: PaletteCommand): void {
    this.commands.set(command.id, command);
  }

  /** Remove a previously registered command. */
  unregister(id: string): void {
    this.commands.delete(id);
  }

  /** Get a specific command by id. */
  get(id: string): PaletteCommand | undefined {
    return this.commands.get(id);
  }

  /** Get all registered commands, in registration order. */
  getAll(): PaletteCommand[] {
    return [...this.commands.values()];
  }

  /** Number of registered commands. */
  get size(): number {
    return this.commands.size;
  }
}

/** Global singleton registry shared via globalThis across module identities. */
const GLOBAL_KEY = Symbol.for("@d3ara1n/pi-command-palette-core/registry");

function createRegistry(): PaletteCommandRegistry {
  const reg = new PaletteCommandRegistry();
  (globalThis as any)[GLOBAL_KEY] = reg;
  return reg;
}

export const paletteCommandRegistry: PaletteCommandRegistry =
  (globalThis as any)[GLOBAL_KEY] ?? createRegistry();
