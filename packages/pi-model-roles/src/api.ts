/**
 * ModelRolesAPI implementation.
 *
 * State stored on globalThis to survive module identity mismatches
 * (extension loaded by absolute path vs import via workspace symlink).
 * Exported functions provide type-safe access — consumers never touch globalThis.
 */

import type { ModelRolesAPI, ModelRolesConfig, RoleConfig, ResolvedRole } from "./types.ts";
import { loadRolesConfig } from "./config.ts";
import { resolveModelForRole, resolveModelForRoleAsync } from "./resolver.ts";

const GLOBAL_KEY = "__piModelRoles";

/** Mutable state. */
interface APIState {
	config: ModelRolesConfig | undefined;
	currentModel: any;
	modelRegistry: any;
}

export function initModelRolesAPI(settings: any, modelRegistry: any, currentModel: any): ModelRolesAPI {
	const state: APIState = {
		config: undefined,
		currentModel,
		modelRegistry,
	};

	function getConfig(): ModelRolesConfig {
		if (!state.config) {
			state.config = loadRolesConfig(settings);
		}
		return state.config;
	}

	const api: ModelRolesAPI = {
		getRoles(): Record<string, RoleConfig> {
			return getConfig().roles;
		},

		getRole(name: string): RoleConfig | undefined {
			return getConfig().roles[name];
		},

		resolveRole(name: string): ResolvedRole {
			const roleConfig = getConfig().roles[name];
			if (!roleConfig) {
				return {
					name,
					config: { model: null },
					model: state.currentModel,
					apiKey: undefined,
					headers: undefined,
				};
			}

			const resolved = resolveModelForRole(roleConfig, state.modelRegistry, state.currentModel);
			return { name, config: roleConfig, ...resolved };
		},

		async resolveRoleAsync(name: string): Promise<ResolvedRole> {
			const roleConfig = getConfig().roles[name];
			if (!roleConfig) {
				if (state.currentModel) {
					const auth = await state.modelRegistry.getApiKeyAndHeaders(state.currentModel);
					return {
						name,
						config: { model: null },
						model: state.currentModel,
						apiKey: auth.ok ? auth.apiKey : undefined,
						headers: auth.ok ? auth.headers : undefined,
					};
				}
				return {
					name,
					config: { model: null },
					model: undefined,
					apiKey: undefined,
					headers: undefined,
				};
			}

			const resolved = await resolveModelForRoleAsync(roleConfig, state.modelRegistry, state.currentModel);
			if (!resolved) {
				return {
					name,
					config: roleConfig,
					model: undefined,
					apiKey: undefined,
					headers: undefined,
				};
			}

			return { name, config: roleConfig, ...resolved };
		},

		getDefaultRole(): string {
			return getConfig().defaultRole ?? "default";
		},

		getVisibleRoles(): Record<string, RoleConfig> {
			const roles = getConfig().roles;
			const result: Record<string, RoleConfig> = {};
			for (const [name, config] of Object.entries(roles)) {
				if (!config.hidden) {
					result[name] = config;
				}
			}
			return result;
		},

		findRoleByModel(modelId: string): string | undefined {
			const roles = getConfig().roles;
			for (const [name, config] of Object.entries(roles)) {
				if (config.model === modelId) {
					return name;
				}
			}
			return undefined;
		},
	};

	// Store on globalThis — survives module identity mismatches
	(globalThis as any)[GLOBAL_KEY] = api;
	return api;
}

/**
 * Update the tracked current model.
 */
export function updateCurrentModel(model: any): void {
	const api = (globalThis as any)[GLOBAL_KEY] as ModelRolesAPI | undefined;
	if (!api) return;
	const state = (api as any).__state as APIState | undefined;
	if (state) {
		state.currentModel = model;
	}
}

/**
 * Get the initialized ModelRolesAPI.
 * Throws if initModelRolesAPI() has not been called yet.
 */
export function getModelRolesAPI(): ModelRolesAPI {
	const api = (globalThis as any)[GLOBAL_KEY] as ModelRolesAPI | undefined;
	if (!api) {
		throw new Error(
			"ModelRolesAPI not initialized. " +
			"Ensure @d3ara1n/pi-model-roles extension is loaded and session_start has fired.",
		);
	}
	return api;
}
