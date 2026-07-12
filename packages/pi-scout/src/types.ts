/**
 * Shared types for pi-scout.
 */

/** Configuration for the scout extension, stored in settings.json. */
export interface ScoutConfig {
  /** Whether scout is enabled globally */
  enabled: boolean;
  /** pi-model-roles role name to use for the side agent */
  sideAgentRole: string;
  /** Maximum number of skills the side agent can select; 0 = unlimited. */
  maxSelectedSkills: number;
  /** Module toggles */
  modules: {
    skillRouter: boolean;
    modelRouter: boolean;
    /** Short-circuit layer: skip the side LLM on high-confidence prompts */
    shortCircuit: boolean;
  };
  /** Tuning for the short-circuit module */
  shortCircuit: ShortCircuitConfig;
}

/**
 * Tuning for the short-circuit module.
 *
 * The short-circuit layer lets scout skip the side model entirely on
 * trivial acknowledgments ("好的" / "ok" / "はい"). A trivial ack means
 * "no skills, don't switch models" — both module answers are certain, so
 * skipping the side model is always safe, even with model-router on.
 * Ambiguous prompts always fall through to the side model, so there is no
 * quality loss on hard cases.
 */
export interface ShortCircuitConfig {
  /** Enable the trivial-acknowledgment rule */
  trivialAck: boolean;
  /** Max prompt length (chars) for the trivial-ack rule. Longer prompts are
   *  never short-circuited as acks even if they begin with an ack word. */
  maxAckLength: number;
  /** Additional ack phrases merged on top of the built-in 中/英/日/韓 table.
   *  Provide raw strings; they are normalized (trimmed, lowercased) at runtime. */
  ackPhrases: string[];
}

/** Decision returned by the side agent or the short-circuit layer. */
export interface ScoutDecision {
  /** Selected skill names */
  skills: string[];
  /** Suggested role name, or null if no change */
  role: string | null;
  /** Brief reasoning */
  reasoning: string;
  /** Where the decision came from — controls status-bar presentation.
   *  "error" renders as a warning (✗) in the status bar instead of polluting the terminal. */
  source?: "side-agent" | "short-circuit" | "error";
}

export const DEFAULT_CONFIG: ScoutConfig = {
  enabled: true,
  sideAgentRole: "utility",
  maxSelectedSkills: 5,
  modules: {
    skillRouter: true,
    modelRouter: false,
    shortCircuit: true,
  },
  shortCircuit: {
    trivialAck: true,
    maxAckLength: 12,
    ackPhrases: [],
  },
};
