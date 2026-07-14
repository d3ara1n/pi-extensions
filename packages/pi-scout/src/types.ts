/**
 * Shared types for pi-scout.
 *
 * Scout is an engine over self-describing {@link ScoutModule}s. The prompt
 * builder, response parser, validator, applier, and status renderer all
 * iterate the registered modules (see `modules/registry.ts`), so adding a
 * module = implement the ScoutModule spec + register it — no edits to the
 * shared engine logic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";

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

/** A loaded skill's metadata, as surfaced to scout by pi. */
export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
}

/**
 * Per-turn context handed to module hooks. A bag of everything any module
 * might need; individual modules read only the fields relevant to them.
 *
 * `systemPrompt` is the current (possibly already-transformed) system prompt;
 * the applier threads it through enabled modules in registry order.
 */
export interface ScoutContext {
  config: ScoutConfig;
  pi: ExtensionAPI;
  rolesApi: ModelRolesAPI;
  skillEntries: SkillEntry[];
  /** Current main-model role name, or "unknown". */
  currentRole: string;
  /** Current system prompt (mutates as modules apply). */
  systemPrompt: string;
  theme: any;
}

/** Result of validating / normalizing a parsed field value. */
export interface ValidateResult<V> {
  value: V;
  /** Failure reason — marks the whole decision as an error. */
  error?: string;
}

/** Result of applying a module's decision. */
export interface ApplyResult {
  /** Replacement system prompt (the module may transform it). */
  systemPrompt?: string;
  /** Failure reason — marks the decision as an error and zeros this field. */
  error?: string;
}

/**
 * Self-describing scout module — the "scout spec".
 *
 * The engine iterates registered modules, so a new module is self-contained:
 * it declares its prompt fragments, parses/validates its own field, renders
 * its own status, and applies its own side effects. No engine edits needed.
 *
 * @typeParam V - the module's decision value type (e.g. `string[]` for skills).
 */
export interface ScoutModule<V = unknown> {
  // ── identity ────────────────────────────────────────────────────
  /** Toggle key in config.modules. */
  readonly key: keyof ScoutConfig["modules"];
  /** Field name in <decision> output and {@link ScoutDecision.fields}. */
  readonly field: string;
  /** Noun for the intro line, e.g. "skills" / "model role". */
  readonly noun: string;
  /** Slash-command label, e.g. "skill-router" → `/scout:skill-router`. */
  readonly label: string;
  /** "## Available X" heading for the candidate section. */
  readonly sectionTitle: string;
  /** Bullet under "Response Rules" (field-format guidance). */
  readonly responseRule: string;

  // ── prompt fragments (contributed only when enabled) ────────────
  /** Line inside the <decision> template. */
  formatLine(ctx: ScoutContext): string;
  /** Behavioral bullets under "Rules". */
  rules(ctx: ScoutContext): string[];
  /** Candidate text for the Available section, or null to omit the section. */
  candidates(ctx: ScoutContext): string | null;
  /** Context line in the user message (e.g. "Current role: …"), or null. */
  promptContextLine(ctx: ScoutContext): string | null;

  // ── decision handling ───────────────────────────────────────────
  /** Parse raw field text into a value (pure). */
  parse(raw: string): V;
  /** Validate / normalize against known candidates. */
  validate(value: V, ctx: ScoutContext): ValidateResult<V>;
  /** Value used when the module is disabled (zeroing). */
  disabledValue(): V;

  // ── output ──────────────────────────────────────────────────────
  /** Status-bar contribution, or null to show nothing for this module. */
  formatStatus(value: V, ctx: ScoutContext): string | null;
  /** Plain-text summary for the /scout command. */
  describe(value: V): string;

  // ── action ──────────────────────────────────────────────────────
  /** Apply the decision: side effects + optional prompt transform. */
  apply(value: V, ctx: ScoutContext): Promise<ApplyResult | void> | ApplyResult | void;
}

/** Decision returned by the side agent or the short-circuit layer. */
export interface ScoutDecision {
  /** Per-module outputs, keyed by module `field`. */
  fields: Record<string, unknown>;
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
