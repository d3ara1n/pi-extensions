/**
 * Read subagent configuration from settings files.
 *
 * Global (~/.pi/agent/settings.json) + project (.pi/settings.json),
 * project overrides global.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SubagentConfig } from "./types.ts";
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

/** Read the `subagent` block from a settings file. */
function readSubagent(filePath: string): Record<string, any> | undefined {
  const raw = readSettingsFile(filePath)?.subagent;
  return raw && typeof raw === "object" ? raw : undefined;
}

/**
 * Load subagent config. Project overrides global wholesale; per-field `??
 * DEFAULT` fills any gap. (No field-level merge — project replaces global.)
 */
export function loadSubagentConfig(cwd?: string): SubagentConfig {
  const globalRaw = readSubagent(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readSubagent(path.join(cwd, ".pi", "settings.json")) : undefined;
  const raw = projectRaw ?? globalRaw;
  if (!raw) return DEFAULT_CONFIG;

  const rawSummary = raw?.summary;
  const rawHistory = raw?.history;
  return {
    timeout: raw.timeout ?? DEFAULT_CONFIG.timeout,
    maxConcurrency: raw.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency,
    maxDepth: raw.maxDepth ?? DEFAULT_CONFIG.maxDepth,
    maxTurns: raw.maxTurns ?? DEFAULT_CONFIG.maxTurns,
    maxCost: raw.maxCost ?? DEFAULT_CONFIG.maxCost,
    history: {
      enabled: rawHistory?.enabled ?? DEFAULT_CONFIG.history.enabled,
    },
    summary: {
      role: rawSummary?.role ?? DEFAULT_CONFIG.summary.role,
      enabled: rawSummary?.enabled ?? DEFAULT_CONFIG.summary.enabled,
    },
    agentOverrides: raw.agentOverrides ?? {},
  };
}
