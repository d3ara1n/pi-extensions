/**
 * Read session-namer configuration from settings files.
 *
 * Global (~/.pi/agent/settings.json) + project (.pi/settings.json),
 * project overrides global.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionNamerConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

function getAgentDir(): string {
  const envDir = process.env.PI_AGENT_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".pi", "agent");
}

function readSettingsFile(filePath: string): any {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/** Read the `sessionNamer` block from a settings file. */
function readNamer(filePath: string): Record<string, any> | undefined {
  const raw = readSettingsFile(filePath)?.sessionNamer;
  return raw && typeof raw === "object" ? raw : undefined;
}

/**
 * Load session-namer config. Project overrides global wholesale; per-field
 * `?? DEFAULT` fills any gap. (No field-level merge — project replaces global.)
 * @param cwd - Project working directory
 */
export function loadNamerConfig(cwd?: string): SessionNamerConfig {
  const globalRaw = readNamer(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readNamer(path.join(cwd, ".pi", "settings.json")) : undefined;
  const raw = projectRaw ?? globalRaw;
  if (!raw) return DEFAULT_CONFIG;

  return {
    enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
    sideAgentRole: raw.sideAgentRole ?? DEFAULT_CONFIG.sideAgentRole,
    maxLength: raw.maxLength ?? DEFAULT_CONFIG.maxLength,
  };
}
