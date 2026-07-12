/**
 * Shared types for pi-session-namer.
 */

/** Configuration for the session-namer extension, stored in settings.json. */
export interface SessionNamerConfig {
  /** Whether auto-naming is enabled */
  enabled: boolean;
  /** pi-model-roles role name for the side agent */
  sideAgentRole: string;
  /** Maximum name length in characters; 0 = unlimited. */
  maxLength: number;
}

export const DEFAULT_CONFIG: SessionNamerConfig = {
  enabled: true,
  sideAgentRole: "utility",
  maxLength: 50,
};
