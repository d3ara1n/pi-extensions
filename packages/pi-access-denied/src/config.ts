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

/** Read and parse a settings.json file (JSONC-aware). Returns parsed object or {}. */
function readSettingsFile(filePath: string): any {
	try {
		if (!fs.existsSync(filePath)) return {};
		const content = fs.readFileSync(filePath, "utf-8");
		// Strip JSONC comments
		const stripped = content
			.replace(/\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "");
		return JSON.parse(stripped);
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
 * Load accessDenied config, merged from global + project settings over defaults.
 * @param cwd - Project working directory (for .pi/settings.json lookup)
 */
export function loadConfig(cwd?: string): AccessDeniedConfig {
	const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
	const projectSettings = cwd ? readSettingsFile(path.join(cwd, ".pi", "settings.json")) : {};

	// Project overrides global. Only the accessDenied key matters here.
	const globalCfg = globalSettings?.accessDenied ?? {};
	const projectCfg = projectSettings?.accessDenied ?? {};
	const raw = { ...globalCfg, ...projectCfg };

	return {
		mode: asMode(raw.mode) ?? DEFAULT_CONFIG.mode,
		extraAllowedDirs: asStringArray(raw.extraAllowedDirs) ?? DEFAULT_CONFIG.extraAllowedDirs,
		extraSafePaths: asStringArray(raw.extraSafePaths) ?? DEFAULT_CONFIG.extraSafePaths,
		tools: asStringArray(raw.tools) ?? DEFAULT_CONFIG.tools,
	};
}
