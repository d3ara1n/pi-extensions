/**
 * Read pi-peek-agent configuration from the `peek` settings block.
 *
 * Only the investigate timeout lives here — discovery/registry/heartbeat config moved
 * to @d3ara1n/pi-mesh's `mesh` block. This package shares the `peek` block with
 * @d3ara1n/pi-peek (which reads serialize-tuning fields there); we read only
 * `investigateTimeoutMs`.
 */

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PeekConfig } from "./types.ts";
import { DEFAULT_PEEK_CONFIG } from "./types.ts";

function readSettingsFile(filePath: string): any {
  // Standard JSON — parse directly; never regex-strip comments (would truncate
  // string literals containing `//` and silently corrupt config).
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
 * `?? DEFAULT` fills any gap. (No field-level merge — project replaces global.)
 */
export function loadPeekConfig(cwd?: string): PeekConfig {
  const globalRaw = readPeek(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readPeek(path.join(cwd, CONFIG_DIR_NAME, "settings.json")) : undefined;
  const raw = projectRaw ?? globalRaw;
  if (!raw) return { ...DEFAULT_PEEK_CONFIG };

  return {
    investigateTimeoutMs: positiveNumber(raw.investigateTimeoutMs, DEFAULT_PEEK_CONFIG.investigateTimeoutMs),
  };
}
