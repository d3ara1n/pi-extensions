/**
 * Read editor-shell configuration from settings files.
 *
 * Global (~/.pi/agent/settings.json) + project (.pi/settings.json).
 * Project settings, when present, override global wholesale — standard
 * "project wins" design, no field-level merging.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface EditorShellConfig {
  /**
   * Status keys to pin to the shell's top-right corner.
   * Only keys set via ctx.ui.setStatus() are eligible.
   */
  pinnedStatus: string[];
}

export const DEFAULT_CONFIG: EditorShellConfig = {
  pinnedStatus: [],
};

function getAgentDir(): string {
  const envDir = process.env.PI_AGENT_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".pi", "agent");
}

/** Read the `editorShell` block from a settings file.
 *  Returns undefined on missing file / parse error / non-object value —
 *  pi surfaces its own settings errors, this loader stays lenient. */
function readEditorShell(filePath: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"))?.editorShell;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load editorShell config. Project overrides global wholesale.
 * @param cwd - Project working directory
 */
export function loadEditorShellConfig(cwd?: string): EditorShellConfig {
  const globalRaw = readEditorShell(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readEditorShell(path.join(cwd, ".pi", "settings.json")) : undefined;
  const raw = projectRaw ?? globalRaw;
  if (!raw) return { ...DEFAULT_CONFIG };

  const pinned = raw.pinnedStatus;
  return {
    pinnedStatus: Array.isArray(pinned)
      ? pinned.filter((k): k is string => typeof k === "string")
      : DEFAULT_CONFIG.pinnedStatus,
  };
}
