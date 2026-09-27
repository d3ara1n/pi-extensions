/**
 * Read subagent configuration from settings files.
 *
 * Pi has two settings scopes: global (~/.pi/agent/settings.json) and project
 * (.pi/settings.json). SettingsManager reads those scopes with project values
 * taking precedence. Its public API exposes the two snapshots separately, so
 * this extension applies the same file-level merge to the custom `subagent`
 * field before normalizing it against DEFAULT_CONFIG.
 */

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { normalizeNonNegativeInteger, normalizeNonNegativeNumber } from "./utils.ts";

type SettingsObject = Record<string, unknown>;

function isSettingsObject(value: unknown): value is SettingsObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Match SettingsManager's merge contract for extension-owned settings:
 * recursively merge plain objects, replace arrays/scalars, and let an
 * explicitly provided value (including null) override the lower layer.
 */
function mergeSettingsObjects(base: SettingsObject, override: unknown): SettingsObject {
  if (!isSettingsObject(override)) return base;

  const merged: SettingsObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (isSettingsObject(merged[key]) && isSettingsObject(value)) {
      merged[key] = mergeSettingsObjects(merged[key] as SettingsObject, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeAgentOverrides(value: unknown): SubagentConfig["agentOverrides"] {
  if (!isSettingsObject(value)) return {};

  const overrides: SubagentConfig["agentOverrides"] = {};
  for (const [role, override] of Object.entries(value)) {
    if (isSettingsObject(override)) {
      overrides[role] = override as SubagentConfig["agentOverrides"][string];
    }
  }
  return overrides;
}

function loadMergedSettings(cwd: string | undefined, projectTrusted: boolean): SettingsObject {
  const hasProjectScope = typeof cwd === "string" && cwd.length > 0;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(hasProjectScope ? cwd : agentDir, agentDir, {
    projectTrusted: hasProjectScope && projectTrusted,
  });
  const globalSettings = settingsManager.getGlobalSettings() as SettingsObject;
  const projectSettings = hasProjectScope
    ? (settingsManager.getProjectSettings() as SettingsObject)
    : {};
  return mergeSettingsObjects(globalSettings, projectSettings);
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Load subagent config from the effective Pi settings.
 *
 * Merge precedence for every field is project > global > builtin defaults.
 * Nested objects, including agentOverrides keyed by role name, are merged
 * recursively. Arrays and scalar values are replaced by the higher layer.
 */
export function loadSubagentConfig(cwd?: string, projectTrusted = true): SubagentConfig {
  const settings = loadMergedSettings(cwd, projectTrusted);
  const mergedRaw = mergeSettingsObjects(
    DEFAULT_CONFIG as unknown as SettingsObject,
    settings.subagent,
  );
  const rawHistory = (isSettingsObject(mergedRaw.history) ? mergedRaw.history : {}) as {
    enabled?: unknown;
  };
  const rawSummary = (isSettingsObject(mergedRaw.summary) ? mergedRaw.summary : {}) as {
    role?: unknown;
    enabled?: unknown;
  };
  const rawInheritance = (isSettingsObject(mergedRaw.inheritance) ? mergedRaw.inheritance : {}) as {
    maxChars?: unknown;
  };
  const rawAgentOverrides = isSettingsObject(mergedRaw.agentOverrides)
    ? mergedRaw.agentOverrides
    : {};

  return {
    maxConcurrency: normalizeNonNegativeInteger(
      mergedRaw.maxConcurrency,
      DEFAULT_CONFIG.maxConcurrency,
    ),
    maxDepth: normalizeNonNegativeInteger(mergedRaw.maxDepth, DEFAULT_CONFIG.maxDepth),
    maxTurns: normalizeNonNegativeInteger(mergedRaw.maxTurns, DEFAULT_CONFIG.maxTurns),
    maxCost: normalizeNonNegativeNumber(mergedRaw.maxCost, DEFAULT_CONFIG.maxCost),
    history: {
      enabled:
        typeof rawHistory.enabled === "boolean"
          ? rawHistory.enabled
          : DEFAULT_CONFIG.history.enabled,
    },
    summary: {
      role: typeof rawSummary.role === "string" ? rawSummary.role : DEFAULT_CONFIG.summary.role,
      enabled:
        typeof rawSummary.enabled === "boolean"
          ? rawSummary.enabled
          : DEFAULT_CONFIG.summary.enabled,
    },
    inheritance: {
      maxChars: normalizePositiveInteger(
        rawInheritance?.maxChars,
        DEFAULT_CONFIG.inheritance.maxChars,
      ),
    },
    agentOverrides: normalizeAgentOverrides(rawAgentOverrides),
  };
}
