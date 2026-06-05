/**
 * Shared types for pi-scout.
 */

/** Configuration for the scout extension, stored in settings.json. */
export interface ScoutConfig {
  /** Whether scout is enabled globally */
  enabled: boolean;
  /** pi-model-roles role name to use for the side agent */
  sideAgentRole: string;
  /** Maximum number of skills the side agent can select */
  maxSelectedSkills: number;
  /** Module toggles */
  modules: {
    skillRouter: boolean;
    modelRouter: boolean;
  };
}

/** Decision returned by the side agent. */
export interface ScoutDecision {
  /** Selected skill names */
  skills: string[];
  /** Suggested role name, or null if no change */
  role: string | null;
  /** Brief reasoning */
  reasoning: string;
}

export const DEFAULT_CONFIG: ScoutConfig = {
  enabled: true,
  sideAgentRole: "utility",
  maxSelectedSkills: 5,
  modules: {
    skillRouter: true,
    modelRouter: true,
  },
};
