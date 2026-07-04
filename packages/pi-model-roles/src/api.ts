/**
 * ModelRolesAPI implementation.
 *
 * State stored on globalThis to survive module identity mismatches
 * (extension loaded by absolute path vs import via workspace symlink).
 * Exported functions provide type-safe access — consumers never touch globalThis.
 */

import { complete as piAiComplete, streamSimple as piAiStreamSimple } from "@earendil-works/pi-ai";
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

export function initModelRolesAPI(
  modelRegistry: any,
  currentModel: any,
  cwd?: string,
): ModelRolesAPI {
  const state: APIState = {
    config: undefined,
    currentModel,
    modelRegistry,
  };

  function getConfig(): ModelRolesConfig {
    if (!state.config) {
      state.config = loadRolesConfig(cwd);
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

      const resolved = await resolveModelForRoleAsync(
        roleConfig,
        state.modelRegistry,
        state.currentModel,
      );
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

    getCurrentRole(modelId: string): string | undefined {
      const roles = getConfig().roles;
      // 1. Exact match wins: a role explicitly bound to this model.
      const exact = Object.entries(roles).find(([, c]) => c.model === modelId)?.[0];
      if (exact) return exact;
      // 2. Default role — when model=null it transparently uses the current
      //    model, so it is the meaningful base in the all-null config.
      const defaultName = getConfig().defaultRole ?? "default";
      const defaultConfig = roles[defaultName];
      if (defaultConfig && !defaultConfig.model) return defaultName;
      // 3. First model=null role (reached only when default is bound elsewhere).
      const nullRole = Object.entries(roles).find(([, c]) => !c.model)?.[0];
      return nullRole;
    },

    listModels(): string[] {
      return state.modelRegistry
        .getAvailable()
        .map((m: { provider: string; id: string }) => `${m.provider}/${m.id}`);
    },

    async complete(roleName: string, context: any, options?: any): Promise<any> {
      // Resolve model: explicit override wins, else the role's declared model
      // (model=null transparently uses pi's current model).
      const roleConfig = getConfig().roles[roleName] ?? { model: null };
      const model =
        options?.model ??
        resolveModelForRole(roleConfig, state.modelRegistry, state.currentModel).model;
      if (!model) {
        throw new Error(`complete: role "${roleName}" has no available model`);
      }
      // Resolve auth for the model actually used (refreshes OAuth tokens).
      const auth = await state.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(`complete: auth failed for ${model.provider}/${model.id}: ${auth.error}`);
      }
      // Forward everything except `model` to pi-ai's complete().
      const { model: _omitModel, ...streamOptions } = options ?? {};
      if (auth.apiKey) streamOptions.apiKey = auth.apiKey;
      if (auth.headers) streamOptions.headers = auth.headers;
      return piAiComplete(model, context, streamOptions);
    },

    async streamWithRole(roleName: string, context: any, options?: any): Promise<any> {
      const roleConfig = getConfig().roles[roleName] ?? { model: null };
      const model =
        options?.model ??
        resolveModelForRole(roleConfig, state.modelRegistry, state.currentModel).model;
      if (!model) {
        throw new Error(`streamWithRole: role "${roleName}" has no available model`);
      }
      const auth = await state.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(
          `streamWithRole: auth failed for ${model.provider}/${model.id}: ${auth.error}`,
        );
      }
      const { model: _omitModel, ...streamOptions } = options ?? {};
      if (auth.apiKey) streamOptions.apiKey = auth.apiKey;
      if (auth.headers) streamOptions.headers = auth.headers;
      return piAiStreamSimple(model, context, streamOptions);
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
