/**
 * Read peek configuration from settings files.
 *
 * Global (~/.pi/agent/settings.json) + project (.pi/settings.json), project
 * overrides global. Mirrors pi-subagent's config loading. Only serialize-tuning
 * lives here; cross-instance config (registry/heartbeat/timeout) belongs to
 * pi-peek-agent.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
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
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/** Read the `peek` block from a settings file. */
function readPeek(filePath: string): Record<string, any> | undefined {
  const raw = readSettingsFile(filePath)?.peek;
  return raw && typeof raw === "object" ? raw : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function roleName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Load peek config. Project overrides global wholesale; per-field defaults fill
 * any gap. (No field-level merge — project replaces global.) */
export function loadPeekConfig(cwd?: string): PeekConfig {
  const globalRaw = readPeek(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readPeek(path.join(cwd, CONFIG_DIR_NAME, "settings.json")) : undefined;
  const raw = projectRaw ?? globalRaw;
  if (!raw) return { ...DEFAULT_PEEK_CONFIG };

  return {
    recentTurns: positiveInteger(raw.recentTurns, DEFAULT_PEEK_CONFIG.recentTurns),
    toolResultLimit: positiveInteger(raw.toolResultLimit, DEFAULT_PEEK_CONFIG.toolResultLimit),
    role: roleName(raw.role, DEFAULT_PEEK_CONFIG.role),
  };
}
