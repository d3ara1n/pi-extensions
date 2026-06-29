/**
 * Type definitions for pi-access-denied.
 */

/** Access control mode. */
export type AccessMode = "prompt" | "deny" | "allow";

/** Per-path choice chosen from the authorization panel. */
export type Choice = "allow" | "always-allow" | "deny" | "always-deny";

/**
 * Result of the authorization panel. `choices` maps each violation path to
 * its chosen action; `reason` is the single global deny reason, present only
 * when at least one deny/always-deny was chosen.
 */
export interface AuthResult {
  cancelled: boolean;
  choices: Map<string, Choice>;
  reason?: string;
}

/**
 * Configuration stored under the `accessDenied` key in pi settings
 * (`~/.pi/agent/settings.json` globally, `.pi/settings.json` per project).
 * Project settings override global ones.
 */
export interface AccessDeniedConfig {
  /** Default mode on session start. Defaults to `"prompt"`. */
  mode: AccessMode;
  /**
   * Paths (absolute or home-relative) always treated as in-bounds, in
   * addition to the current project cwd. Merges the former `extraAllowedDirs`
   * (full read/write roots) and `extraSafePaths` (fine-grained) — both were
   * prefix matches with identical effect, so they are unified here.
   */
  allowedPaths: string[];
  /**
   * Paths (absolute or home-relative) that are always denied, each mapping
   * to an OPTIONAL reason shown back to the agent. A `null` reason means
   * "deny with the default message".
   *
   * AUTHORING FORMAT (in settings.json): an array of groups, each binding a
   * `paths` array to one shared `reason` — see {@link loadConfig}'s parser:
   *
   *   [
   *     { "paths": ["/old/a", "/old/b"], "reason": "moved to /new" },
   *     { "paths": ["/cache"] }            // reason omitted → null
   *   ]
   *
   * loadConfig flattens that into this map ({ path → reason|null }), which is
   * the normalized form the PathManager consumes. Grouping is purely an
   * authoring convenience; it is not preserved internally.
   *
   * Primary use case: redirect an agent away from a stale/renamed data dir —
   * deny the old path and put the new location in the reason, so the agent
   * learns the redirect instead of scrambling to search the disk.
   *
   * Resolution is LONGEST-PREFIX-MATCH (see path-manager.ts): the most
   * specific rule covering a target wins, regardless of whether it comes
   * from `allowedPaths`, `deniedPaths`, or a runtime session decision.
   * A same-depth allow/deny conflict resolves to deny.
   */
  deniedPaths: Record<string, string | null>;
  /** Built-in tools to gate. Defaults to `["write", "edit", "bash"]`. */
  tools: string[];
}

export const DEFAULT_CONFIG: AccessDeniedConfig = {
  mode: "prompt",
  allowedPaths: [],
  deniedPaths: {},
  tools: ["write", "edit", "bash"],
};
