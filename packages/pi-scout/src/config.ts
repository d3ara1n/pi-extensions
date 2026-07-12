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
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/** Read the `scout` block from a settings file. */
function readScout(filePath: string): Record<string, any> | undefined {
  const raw = readSettingsFile(filePath)?.scout;
  return raw && typeof raw === "object" ? raw : undefined;
}

/**
 * Load scout config. Project overrides global wholesale; per-field `??
 * DEFAULT` fills any gap. (No field-level merge — project replaces global.)
 * @param cwd - Project working directory
 */
export function loadScoutConfig(cwd?: string): ScoutConfig {
  const globalRaw = readScout(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readScout(path.join(cwd, ".pi", "settings.json")) : undefined;
  const raw = projectRaw ?? globalRaw;
  if (!raw) return DEFAULT_CONFIG;

  const maxSelectedSkills =
    typeof raw.maxSelectedSkills === "number" && Number.isFinite(raw.maxSelectedSkills)
      ? Math.max(0, Math.floor(raw.maxSelectedSkills))
      : DEFAULT_CONFIG.maxSelectedSkills;

  return {
    enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
    sideAgentRole: raw.sideAgentRole ?? DEFAULT_CONFIG.sideAgentRole,
    maxSelectedSkills,
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
