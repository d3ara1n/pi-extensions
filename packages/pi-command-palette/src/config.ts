/**
 * Resolve the command-palette shortcut key from configuration sources.
 *
 * Priority (highest wins):
 *   1. `PI_COMMAND_PALETTE_KEY` env var — works even when the terminal intercepts
 *      `Ctrl+Shift+P` before it reaches the session (e.g. Termius on Windows/WSL2).
 *   2. `settings.json` `commandPalette.shortcut` (a present project
 *      `commandPalette` block replaces the global block)
 *   3. default `"ctrl+shift+p"`
 *
 * Why not a CLI flag? Flags are applied to the extension runtime AFTER extensions
 * load, so `pi.getFlag()` only returns the registered default at `registerShortcut()`
 * time. Env vars and settings files are both available immediately at process
 * start, so they are the correct mechanisms here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";

export const DEFAULT_SHORTCUT = "ctrl+shift+p";

function getAgentDir(): string {
  const envDir = process.env.PI_AGENT_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".pi", "agent");
}

function readSettings(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

/** Lowercase + trim; returns undefined for empty/non-string input. */
function normalizeKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  return trimmed || undefined;
}

/**
 * Resolve the command-palette shortcut key from env var → settings → default.
 *
 * @param cwd - Project working directory, for project-level settings override.
 *   Defaults to `process.cwd()` (accurate at pi startup when shortcuts register).
 */
export function resolveShortcutKey(cwd: string = process.cwd()): KeyId {
  // 1. Env var — highest priority, for terminals that intercept the default combo.
  const envKey = normalizeKey(process.env.PI_COMMAND_PALETTE_KEY);
  if (envKey) return envKey as KeyId;

  // 2. settings.json — a present project block replaces the global block.
  const globalSettings = readSettings(path.join(getAgentDir(), "settings.json"));
  const projectSettings = readSettings(path.join(cwd, ".pi", "settings.json"));
  const globalRaw = globalSettings.commandPalette;
  const projectRaw = projectSettings.commandPalette;
  const config = (projectRaw ?? globalRaw ?? {}) as { shortcut?: unknown };
  const settingsKey = normalizeKey(config.shortcut);
  if (settingsKey) return settingsKey as KeyId;

  // 3. default
  return DEFAULT_SHORTCUT as KeyId;
}
