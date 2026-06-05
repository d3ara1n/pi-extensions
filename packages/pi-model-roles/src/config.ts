/**
 * Read role configuration from settings files.
 *
 * Reads global (~/.pi/agent/settings.json) and project-level (.pi/settings.json)
 * settings, merges them with project overriding global.
 * Built-in defaults form the base.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRolesConfig, RoleConfig } from "./types.ts";
import { BUILTIN_DEFAULT_ROLES } from "./defaults.ts";

const DEFAULT_ROLE_NAME = "default";

/** Get the pi agent directory path. */
function getAgentDir(): string {
	const envDir = process.env.PI_AGENT_DIR;
	if (envDir) return envDir;
	return path.join(os.homedir(), ".pi", "agent");
}

/** Read and parse a settings.json file. Returns parsed object or empty. */
function readSettingsFile(filePath: string): any {
	try {
		if (!fs.existsSync(filePath)) return {};
		const content = fs.readFileSync(filePath, "utf-8");
		// Strip JSONC comments
		const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
		return JSON.parse(stripped);
	} catch {
		return {};
	}
}

/** Deep merge source into target (source wins on conflict). Only handles plain objects. */
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

/**
 * Load modelRoles config, merged from global + project settings.
 * @param cwd - Project working directory (for .pi/settings.json lookup)
 */
export function loadRolesConfig(cwd?: string): ModelRolesConfig {
	// Read global settings
	const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));

	// Read project settings
	const projectSettings = cwd
		? readSettingsFile(path.join(cwd, ".pi", "settings.json"))
		: {};

	// Merge: project overrides global
	const settings = merge(globalSettings, projectSettings);

	// Start from built-in defaults
	const mergedRoles: Record<string, RoleConfig> = {};
	for (const [name, config] of Object.entries(BUILTIN_DEFAULT_ROLES)) {
		mergedRoles[name] = { ...config };
	}

	// Merge user config over defaults
	const userConfig = settings?.modelRoles;
	if (userConfig?.roles && typeof userConfig.roles === "object") {
		for (const [name, config] of Object.entries(userConfig.roles as Record<string, Partial<RoleConfig>>)) {
			if (mergedRoles[name]) {
				mergedRoles[name] = { ...mergedRoles[name], ...config };
			} else {
				mergedRoles[name] = config as RoleConfig;
			}
		}
	}

	return {
		roles: mergedRoles,
		defaultRole: userConfig?.defaultRole ?? DEFAULT_ROLE_NAME,
	};
}
