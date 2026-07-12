/**
 * Read access-denied configuration from settings files.
 *
 * Reads global (~/.pi/agent/settings.json) and project-level (.pi/settings.json)
 * settings, merges them (project overrides global), and layers on built-in
 * defaults. Mirrors the pattern used by other extensions in this monorepo.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type AccessDeniedConfig, type AccessMode } from "./types.ts";
/** Get the pi agent directory path. Honors PI_AGENT_DIR override. */
function getAgentDir(): string {
  const envDir = process.env.PI_AGENT_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".pi", "agent");
}

/** Read and parse a settings.json file. Returns parsed object or {}. */
function readSettingsFile(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

const VALID_MODES: ReadonlySet<AccessMode> = new Set(["prompt", "deny", "allow"]);

function asMode(value: unknown): AccessMode | undefined {
  return typeof value === "string" && VALID_MODES.has(value as AccessMode)
    ? (value as AccessMode)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Parse the user-facing `deniedPaths` format into the flat map the PathManager
 * consumes. The authoring format groups paths by their reason, so several
 * paths sharing one reason (or no reason) are written together:
 *
 *   [
 *     { "paths": ["/old/a", "/old/b"], "reason": "moved to /new" },
 *     { "paths": ["/cache"] }            // reason omitted → default message
 *   ]
 *
 * Flattens to { "/old/a": "moved to /new", "/old/b": "moved to /new", "/cache": null }.
 *
 * `reason` accepts: omitted / null → null (default message); a string → that
 * reason. A non-string, non-null reason drops the WHOLE group (likely a typo).
 * Malformed entries (non-object, missing/empty `paths`) are skipped. A path
 * appearing in several groups keeps the LAST group's reason (predictable).
 * This lenient parsing means a typo in settings can never crash the gate.
 */
function asDeniedPaths(value: unknown): Record<string, string | null> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, string | null> = {};
  for (const group of value) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const g = group as Record<string, unknown>;
    const paths = g.paths;
    if (!Array.isArray(paths)) continue; // missing or non-array paths → skip group
    // reason: omitted / null → null; string → that string; else skip group.
    let reason: string | null;
    if (g.reason === undefined || g.reason === null) reason = null;
    else if (typeof g.reason === "string") reason = g.reason;
    else continue;
    for (const p of paths) {
      if (typeof p === "string" && p.trim()) out[p] = reason;
    }
  }
  return out;
}

/**
 * Load accessDenied config from project or global settings over defaults.
 * A present project `accessDenied` object replaces the global object entirely;
 * missing fields then fall back to DEFAULT_CONFIG.
 * @param cwd - Project working directory (for .pi/settings.json lookup)
 */
export function loadConfig(cwd?: string): AccessDeniedConfig {
  const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
  const projectSettings = cwd ? readSettingsFile(path.join(cwd, ".pi", "settings.json")) : {};

  // A project accessDenied block replaces the global block as a whole. Fields
  // omitted from that selected block fall back to DEFAULT_CONFIG below.
  const globalRaw = globalSettings?.accessDenied;
  const projectRaw = projectSettings?.accessDenied;
  const raw = projectRaw ?? globalRaw ?? {};

  return {
    mode: asMode(raw.mode) ?? DEFAULT_CONFIG.mode,
    allowedPaths: asStringArray(raw.allowedPaths) ?? DEFAULT_CONFIG.allowedPaths,
    deniedPaths: asDeniedPaths(raw.deniedPaths),
    tools: asStringArray(raw.tools) ?? DEFAULT_CONFIG.tools,
  };
}
