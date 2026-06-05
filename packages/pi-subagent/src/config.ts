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
		if (!fs.existsSync(filePath)) return {};
		const content = fs.readFileSync(filePath, "utf-8");
		const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
		return JSON.parse(stripped);
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

export function loadSubagentConfig(cwd?: string): SubagentConfig {
	const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
	const projectSettings = cwd
		? readSettingsFile(path.join(cwd, ".pi", "settings.json"))
		: {};
	const settings = merge(globalSettings, projectSettings);

	const raw = settings?.subagent;
	if (!raw) return DEFAULT_CONFIG;

	const rawSummary = raw?.summary;
	return {
		timeoutMs: raw.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
		summary: {
			role: rawSummary?.role ?? DEFAULT_CONFIG.summary.role,
			enabled: rawSummary?.enabled ?? DEFAULT_CONFIG.summary.enabled,
		},
	};
}
