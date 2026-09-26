/**
 * Read subagent configuration from settings files.
 *
 * Global (~/.pi/agent/settings.json) + project (.pi/settings.json).
 * The project block overrides the global block at the field level: only the
 * fields a project explicitly sets win, fields neither sets fall back to
 * DEFAULT_CONFIG.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { normalizeNonNegativeInteger, normalizeNonNegativeNumber } from "./utils.ts";

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : fallback;
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
 * Load subagent config. The project `subagent` block is merged into the global
 * block at the field level — only the fields a project explicitly sets override
 * the global, and any field neither sets falls back to DEFAULT_CONFIG.
 *
 * Merge precedence for every field: project value > global value >
 * DEFAULT_CONFIG. Nested blocks (history / summary / inheritance) merge field by
 * field, and `agentOverrides` merges per role name (project role fields are
 * merged into global role fields; roles present only in the project are added).
 */
export function loadSubagentConfig(cwd?: string): SubagentConfig {
  const globalRaw = readSubagent(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readSubagent(path.join(cwd, ".pi", "settings.json")) : undefined;
  if (!globalRaw && !projectRaw) return DEFAULT_CONFIG;

  // Per-field scalar: project wins, then global, then DEFAULT (handled by the
  // normalize calls below).
  const scalar = (key: keyof SubagentConfig): unknown => projectRaw?.[key] ?? globalRaw?.[key];

  // Nested blocks merge field by field (project over global).
  const rawSummary = { ...globalRaw?.summary, ...projectRaw?.summary };
  const rawHistory = { ...globalRaw?.history, ...projectRaw?.history };
  const rawInheritance = { ...globalRaw?.inheritance, ...projectRaw?.inheritance };

  // agentOverrides merges per role: project fields merge over global fields for
  // shared roles, and project-only roles are added. Global-only roles survive.
  const mergedAgentOverrides: Record<string, any> = { ...(globalRaw?.agentOverrides ?? {}) };
  for (const [role, override] of Object.entries(projectRaw?.agentOverrides ?? {})) {
    mergedAgentOverrides[role] = { ...(mergedAgentOverrides[role] ?? {}), ...(override as object) };
  }

  return {
    maxConcurrency: normalizeNonNegativeInteger(
      scalar("maxConcurrency"),
      DEFAULT_CONFIG.maxConcurrency,
    ),
    maxDepth: normalizeNonNegativeInteger(scalar("maxDepth"), DEFAULT_CONFIG.maxDepth),
    maxTurns: normalizeNonNegativeInteger(scalar("maxTurns"), DEFAULT_CONFIG.maxTurns),
    maxCost: normalizeNonNegativeNumber(scalar("maxCost"), DEFAULT_CONFIG.maxCost),
    history: {
      enabled: rawHistory?.enabled ?? DEFAULT_CONFIG.history.enabled,
    },
    summary: {
      role: rawSummary?.role ?? DEFAULT_CONFIG.summary.role,
      enabled: rawSummary?.enabled ?? DEFAULT_CONFIG.summary.enabled,
    },
    inheritance: {
      maxChars: normalizePositiveInteger(
        rawInheritance?.maxChars,
        DEFAULT_CONFIG.inheritance.maxChars,
      ),
    },
    agentOverrides: mergedAgentOverrides,
  };
}
