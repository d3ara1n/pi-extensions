/**
 * Module registry — the single source of truth for "which modules exist".
 *
 * Order matters: the prompt builder emits Available sections and the applier
 * threads the system prompt in this order. Skills come first so the longer,
 * cache-friendly skills prefix is followed by the (shorter, more volatile)
 * roles section — toggling model-router only invalidates the cache tail.
 *
 * Adding a module: implement {@link ScoutModule} in its own file, import it
 * here, append to MODULES. No other file needs editing.
 */

import type { ScoutModule } from "../types.ts";
import { skillRouterModule } from "./skill-router.ts";
import { modelRouterModule } from "./model-router.ts";

export const MODULES: ScoutModule[] = [skillRouterModule, modelRouterModule];

/** Modules enabled under the given config, in registry order. */
export function enabledModules(config: { modules: Record<string, boolean> }): ScoutModule[] {
  return MODULES.filter((m) => config.modules[m.key]);
}

/** Build a fields record filled with every module's disabled value. */
export function emptyFields(): Record<string, unknown> {
  return Object.fromEntries(MODULES.map((m) => [m.field, m.disabledValue()]));
}
