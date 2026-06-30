/**
 * Read editor-shell configuration from settings files.
 *
 * Global (~/.pi/agent/settings.json) + project (.pi/settings.json),
 * project overrides global.
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

function readSettingsFile(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function merge(target: any, source: any): any {
  if (!source || typeof source !== "object") return target;
  if (!target || typeof target !== "object") return source;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = merge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Load editorShell config from merged settings.
 * @param cwd - Project working directory
 */
export function loadEditorShellConfig(cwd?: string): EditorShellConfig {
  const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
  const projectSettings = cwd ? readSettingsFile(path.join(cwd, ".pi", "settings.json")) : {};
  const settings = merge(globalSettings, projectSettings);

  const raw = settings?.editorShell;
  if (!raw) return { ...DEFAULT_CONFIG };

  return {
    pinnedStatus: Array.isArray(raw.pinnedStatus)
      ? raw.pinnedStatus.filter((k: any) => typeof k === "string")
      : DEFAULT_CONFIG.pinnedStatus,
  };
}
