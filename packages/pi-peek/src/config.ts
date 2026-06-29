/**
 * Read peek configuration from settings files.
 *
 * Global (~/.pi/agent/settings.json) + project (.pi/settings.json), project
 * overrides global. Mirrors pi-subagent's config loading. Only serialize-tuning
 * lives here; cross-instance config (registry/heartbeat/timeout) belongs to
 * pi-peek-agent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PeekConfig } from "./types.ts";
import { DEFAULT_PEEK_CONFIG } from "./types.ts";

function getAgentDir(): string {
  const envDir = process.env["PI_AGENT_DIR"];
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

export function loadPeekConfig(cwd?: string): PeekConfig {
  const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
  const projectSettings = cwd ? readSettingsFile(path.join(cwd, ".pi", "settings.json")) : {};
  const settings = merge(globalSettings, projectSettings);

  const raw = settings?.peek;
  if (!raw) return { ...DEFAULT_PEEK_CONFIG };

  return {
    recentTurns: raw.recentTurns ?? DEFAULT_PEEK_CONFIG.recentTurns,
    maxChars: raw.maxChars ?? DEFAULT_PEEK_CONFIG.maxChars,
    toolResultLimit: raw.toolResultLimit ?? DEFAULT_PEEK_CONFIG.toolResultLimit,
    role: raw.role ?? DEFAULT_PEEK_CONFIG.role,
  };
}
