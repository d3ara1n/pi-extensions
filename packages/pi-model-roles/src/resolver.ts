/**
 * Resolve role names to Model instances using pi's ModelRegistry.
 *
 * model=null in RoleConfig is transparently resolved to the current model.
 * Callers never see null — they get a real model or undefined.
 */

import type { RoleConfig, ResolvedRole } from "./types.ts";

/** Minimal interface from ModelRegistry. */
interface ModelRegistryLike {
  getAvailable(): any[];
  getApiKeyAndHeaders(
    model: any,
  ): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
}

interface ModelLike {
  provider: string;
  id: string;
}

function parseModelIdentifier(modelRef: string): { provider: string | undefined; modelId: string } {
  const parts = modelRef.split("/");
  if (parts.length > 1) {
    return { provider: parts[0], modelId: parts.slice(1).join("/") };
  }
  return { provider: undefined, modelId: parts[0] };
}

function findModel(modelRef: string, available: ModelLike[]): ModelLike | undefined {
  const { provider, modelId } = parseModelIdentifier(modelRef);
  return available.find((m) => {
    if (provider) return m.provider === provider && m.id === modelId;
    return m.id === modelId;
  });
}

/**
 * Sync resolve. model=null → uses currentModel if provided, else undefined.
 */
export function resolveModelForRole(
  roleConfig: RoleConfig,
  modelRegistry: ModelRegistryLike,
  currentModel: any | undefined,
): Pick<ResolvedRole, "model" | "apiKey" | "headers"> {
  // model=null: fill with pi's current model
  if (!roleConfig.model) {
    return { model: currentModel, apiKey: undefined, headers: undefined };
  }

  const match = findModel(roleConfig.model, modelRegistry.getAvailable());
  return { model: match ?? undefined, apiKey: undefined, headers: undefined };
}

/**
 * Async resolve with auth. model=null → resolves currentModel's auth too.
 */
export async function resolveModelForRoleAsync(
  roleConfig: RoleConfig,
  modelRegistry: ModelRegistryLike,
  currentModel: any | undefined,
): Promise<Pick<ResolvedRole, "model" | "apiKey" | "headers"> | undefined> {
  // model=null: fill with pi's current model + its auth
  if (!roleConfig.model) {
    if (!currentModel) return undefined;
    const auth = await modelRegistry.getApiKeyAndHeaders(currentModel);
    if (!auth.ok) return undefined;
    return { model: currentModel, apiKey: auth.apiKey, headers: auth.headers };
  }

  const available = modelRegistry.getAvailable();
  const match = findModel(roleConfig.model, available);
  if (!match) return undefined;

  const auth = await modelRegistry.getApiKeyAndHeaders(match);
  if (!auth.ok) return undefined;

  return { model: match, apiKey: auth.apiKey, headers: auth.headers };
}
