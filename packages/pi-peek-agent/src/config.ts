/**
 * Read pi-peek-agent configuration from the `peek` settings block.
 *
 * Shares the `peek` block with @d3ara1n/pi-peek (which reads serialize-tuning
 * fields there). This package reads only the cross-instance fields.
 */

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

export function loadAgentConfig(cwd?: string): AgentConfig {
	const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
	const projectSettings = cwd ? readSettingsFile(path.join(cwd, ".pi", "settings.json")) : {};
	const settings = merge(globalSettings, projectSettings);

	const raw = settings?.peek;
	if (!raw) return { ...DEFAULT_AGENT_CONFIG };

	return {
		registryDir: raw.registryDir,
		heartbeatMs: raw.heartbeatMs ?? DEFAULT_AGENT_CONFIG.heartbeatMs,
		staleMs: raw.staleMs ?? DEFAULT_AGENT_CONFIG.staleMs,
		askTimeoutMs: raw.askTimeoutMs ?? DEFAULT_AGENT_CONFIG.askTimeoutMs,
	};
}
