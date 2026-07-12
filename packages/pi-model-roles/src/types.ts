/**
 * Shared types for pi-model-roles.
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

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
  /** If true, hide this role from user-facing listings */
  hidden?: boolean;
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
   * Resolve a requested role name to a model instance (sync, no auth).
   * Unknown names use the configured default role's config, but the returned
   * `name` remains the requested name. `getRole()` remains a declared-role
   * lookup, so callers never mistake an unknown name for a defined role.
   * model=null is transparently resolved to pi's current model.
   * Returns model=undefined only if the effective role is unavailable.
   */
  resolveRole(name: string): ResolvedRole;
  /**
   * Resolve a requested role name with auth info (async). Unknown names use
   * the configured default role's config once, then return the current model
   * or undefined when that effective role cannot resolve.
   * model=null is transparently resolved to pi's current model.
   */
  resolveRoleAsync(name: string): Promise<ResolvedRole>;
  /** Get the default role name. */
  getDefaultRole(): string;
  /** Get all non-hidden roles (for displaying to users). */
  getVisibleRoles(): Record<string, RoleConfig>;
  /**
   * Given a model identifier (e.g. "anthropic/claude-sonnet-4"), find the first
   * role name that is explicitly bound to that model. Skips roles with
   * model=null (they have no declared model to match).
   *
   * This is a pure declared-binding lookup — it does NOT infer "the current
   * role". For that, use {@link getCurrentRole}.
   *
   * Returns undefined if no role declares this model.
   */
  findRoleByModel(modelId: string): string | undefined;

  /**
   * Identify which role the currently-active model belongs to. Resolution order:
   *   1. Exact match — a role explicitly bound to `modelId`
   *      ({@link findRoleByModel}).
   *   2. The configured default role — if it is model=null, the current model
   *      is transparently "the default role's model", so default is the
   *      meaningful base. This covers the common config where ALL roles are
   *      model=null (use current model): without this step, whichever null
   *      role iterates first would win — often a hidden utility role.
   *   3. The first model=null role found (it too transparently uses the current
   *      model); only reached when the default role is explicitly bound to a
   *      different model.
   * Returns undefined only if no role matches by any rule.
   */
  getCurrentRole(modelId: string): string | undefined;
  /** List all available models from pi's model registry. Returns provider/id strings (e.g. "anthropic/claude-sonnet-4"). */
  listModels(): string[];

  /**
   * Call pi-ai's completeSimple() with auth and thinking resolved from the role.
   *
   * Convenience: same as streamWithRole().result(). Auth (including OAuth
   * token refresh) is resolved for the model actually used, so callers never
   * handle API keys or headers. The role's {@link RoleConfig.thinking} level
   * is applied as `reasoning` unless the caller sets it explicitly.
   * No fallback, no retry, no error swallowing; throws if the role has no
   * available model or auth resolution fails.
   *
   * @param roleName - Role whose model + auth + thinking to use
   * @param context - Conversation context (systemPrompt + messages)
   * @param options - Stream options forwarded to pi-ai's completeSimple().
   *   Pass `model` to override the role's model (auth is then resolved for
   *   that model); pass `reasoning` to override the role's thinking level;
   *   all other fields pass through unchanged.
   */
  completeWithRole<TApi extends Api = Api>(
    roleName: string,
    context: Context,
    options?: ProviderStreamOptions & { model?: Model<TApi> },
  ): Promise<AssistantMessage>;

  /**
   * Call pi-ai's streamSimple() with auth resolved internally from the role's model.
   *
   * Streaming counterpart to {@link completeWithRole}. Same auth resolution (including
   * OAuth token refresh), same thinking-level application (role's
   * {@link RoleConfig.thinking} → `reasoning` unless overridden), and same
   * error semantics (throws on no model / auth failure). Returns the pi-ai
   * event stream — iterate it for events, call `.result()` for the final
   * AssistantMessage.
   *
   * Note: unlike pi-ai's synchronous `streamSimple`, this is async because auth
   * resolution (OAuth token refresh) must complete before the stream starts.
   *
   * @param roleName - Role whose model + auth + thinking to use
   * @param context - Conversation context (systemPrompt + messages)
   * @param options - Stream options forwarded to pi-ai's streamSimple(). Pass
   *   `model` to override the role's model; pass `reasoning` to override the
   *   role's thinking level; all other fields pass through.
   */
  streamWithRole<TApi extends Api = Api>(
    roleName: string,
    context: Context,
    options?: SimpleStreamOptions & { model?: Model<TApi> },
  ): Promise<AssistantMessageEventStream>;
}
