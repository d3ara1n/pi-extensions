/**
 * Read scout configuration from settings files.
 *
 * Global (~/.pi/agent/settings.json) + project (.pi/settings.json),
 * project overrides global.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ScoutConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

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
 * Load scout config from merged settings.
 * @param cwd - Project working directory
 */
export function loadScoutConfig(cwd?: string): ScoutConfig {
  const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
  const projectSettings = cwd ? readSettingsFile(path.join(cwd, ".pi", "settings.json")) : {};
  const settings = merge(globalSettings, projectSettings);

  const raw = settings?.scout;
  if (!raw) return DEFAULT_CONFIG;

  return {
    enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
    sideAgentRole: raw.sideAgentRole ?? DEFAULT_CONFIG.sideAgentRole,
    maxSelectedSkills: raw.maxSelectedSkills ?? DEFAULT_CONFIG.maxSelectedSkills,
    modules: {
      skillRouter: raw.modules?.skillRouter ?? DEFAULT_CONFIG.modules.skillRouter,
      modelRouter: raw.modules?.modelRouter ?? DEFAULT_CONFIG.modules.modelRouter,
      shortCircuit: raw.modules?.shortCircuit ?? DEFAULT_CONFIG.modules.shortCircuit,
    },
    shortCircuit: {
      trivialAck: raw.shortCircuit?.trivialAck ?? DEFAULT_CONFIG.shortCircuit.trivialAck,
      maxAckLength: raw.shortCircuit?.maxAckLength ?? DEFAULT_CONFIG.shortCircuit.maxAckLength,
      ackPhrases: Array.isArray(raw.shortCircuit?.ackPhrases)
        ? raw.shortCircuit.ackPhrases.filter((p: any) => typeof p === "string")
        : DEFAULT_CONFIG.shortCircuit.ackPhrases,
    },
  };
}
