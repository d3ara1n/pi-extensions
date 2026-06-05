/**
 * Shared types for pi-model-roles.
 */

/** Thinking level configuration for a role. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Configuration for a single model role. */
export interface RoleConfig {
  /**
   * Model identifier, format: "provider/model-id".
   * null = use pi's current model (resolved internally, never exposed to consumers).
   */
  model: string | null;
  /** Thinking level for this role */
  thinking?: ThinkingLevel;
  /** Human-readable description of when to use this role */
  description?: string;
  /** Comma-separated list of tools available to this role */
  tools?: string;
  /** If true, hide this role from user-facing listings */
  hidden?: boolean;
  /** Additional system prompt content appended when this role is active */
  systemPromptAppend?: string;
}

/** Top-level modelRoles configuration stored in pi settings. */
export interface ModelRolesConfig {
  /** Map of role name → role configuration */
  roles: Record<string, RoleConfig>;
  /** Fallback role name when a requested role doesn't exist */
  defaultRole?: string;
}

/** A fully resolved role — consumers never see null. */
export interface ResolvedRole {
  /** The role name */
  name: string;
  /** The original role configuration */
  config: RoleConfig;
  /** Resolved Model instance (always a real model, or undefined if unavailable) */
  model: any | undefined; // Model<Api>
  /** API key for this model */
  apiKey: string | undefined;
  /** Custom headers for API requests */
  headers: Record<string, string> | undefined;
}

/** Public API exposed via getModelRolesAPI(). */
export interface ModelRolesAPI {
  /** Read all role configurations. */
  getRoles(): Record<string, RoleConfig>;
  /** Get a single role configuration by name. */
  getRole(name: string): RoleConfig | undefined;
  /**
   * Resolve a role name to a model instance (sync, no auth).
   * model=null is transparently resolved to pi's current model.
   * Returns model=undefined only if the model is truly unavailable.
   */
  resolveRole(name: string): ResolvedRole;
  /**
   * Resolve a role name to a model instance with auth info (async).
   * model=null is transparently resolved to pi's current model.
   * Returns model=undefined only if the model is truly unavailable.
   */
  resolveRoleAsync(name: string): Promise<ResolvedRole>;
  /** Get the default role name. */
  getDefaultRole(): string;
  /** Get all non-hidden roles (for displaying to users). */
  getVisibleRoles(): Record<string, RoleConfig>;
  /**
   * Given a model identifier (e.g. "anthropic/claude-sonnet-4"),
   * find the first role name that uses that model.
   * Skips roles with model=null.
   */
  findRoleByModel(modelId: string): string | undefined;
}
