/**
 * Read pi-peek-agent configuration from the `peek` settings block.
 *
 * Shares the `peek` block with @d3ara1n/pi-peek (which reads serialize-tuning
 * fields there). This package reads only the cross-instance fields.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./types.ts";
import { DEFAULT_AGENT_CONFIG } from "./types.ts";

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

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Load pi-peek-agent config. Project overrides global wholesale; per-field
 * `?? DEFAULT` fills any gap. (No field-level merge — project replaces global.) */
export function loadAgentConfig(cwd?: string): AgentConfig {
  const globalRaw = readPeek(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readPeek(path.join(cwd, CONFIG_DIR_NAME, "settings.json")) : undefined;
  const raw = projectRaw ?? globalRaw;
  if (!raw) return { ...DEFAULT_AGENT_CONFIG };

  return {
    registryDir: typeof raw.registryDir === "string" && raw.registryDir.trim() ? raw.registryDir : undefined,
    heartbeatMs: positiveNumber(raw.heartbeatMs, DEFAULT_AGENT_CONFIG.heartbeatMs),
    askTimeoutMs: positiveNumber(raw.askTimeoutMs, DEFAULT_AGENT_CONFIG.askTimeoutMs),
  };
}
