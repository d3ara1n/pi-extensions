/**
 * Scout decision engine — pure orchestration over the module registry.
 *
 * Deliberately separated from `index.ts` (the pi wiring): this module has no
 * value imports from pi-coding-agent / pi-model-roles, only type-only imports,
 * so it can be unit-tested in isolation (importing index.ts would pull
 * node_modules source that Node refuses to type-strip).
 *
 * The engine knows nothing about how decisions are triggered or how pi
 * renders them — it only validates, applies, and formats decisions against
 * the registered modules.
 */

import type { ScoutContext, ScoutDecision } from "./types.ts";
import { MODULES, enabledModules } from "./modules/registry.ts";

/** Status-bar prefix: icon in its state color, the "scout:" label always dim. */
export function scoutPrefix(icon: string, color: string, theme: any): string {
  return theme.fg(color, icon) + theme.fg("dim", " scout:") + " ";
}

/** Build a one-line status summary from a scout decision. */
export function formatDecisionStatus(decision: ScoutDecision, ctx: ScoutContext): string {
  const theme = ctx.theme;
  if (decision.source === "error") {
    return scoutPrefix("✗", "warning", theme) + theme.fg("warning", decision.reasoning);
  }

  if (decision.source === "short-circuit") {
    return scoutPrefix("✓", "success", theme) + theme.fg("dim", `(skipped) ${decision.reasoning}`);
  }

  const parts: string[] = [];
  for (const m of enabledModules(ctx.config)) {
    const segment = m.formatStatus(decision.fields[m.field] as never, ctx);
    if (segment) parts.push(segment);
  }

  if (parts.length === 0) {
    return scoutPrefix("✓", "success", theme) + theme.fg("dim", "no changes");
  }

  return scoutPrefix("✓", "success", theme) + parts.join(theme.fg("dim", " | "));
}

/**
 * Validate + zero a parsed decision against the registry.
 *
 * Enabled modules validate/normalize their field (and may flag an error);
 * disabled modules are zeroed to their disabled value so downstream code
 * always sees a complete fields record. Pure — no side effects.
 *
 * The result spreads the original decision and overrides only what this step
 * actually changes (`fields`, and `source`/`reasoning` on a validate error),
 * so any other field on ScoutDecision — notably `errorDetail` — is carried
 * through automatically. Adding a field can never silently drop here.
 *
 * @internal — exported for testing.
 */
export function normalizeDecision(decision: ScoutDecision, ctx: ScoutContext): ScoutDecision {
  const fields: Record<string, unknown> = { ...decision.fields };
  let source = decision.source;
  let reasoning = decision.reasoning;

  for (const m of MODULES) {
    if (ctx.config.modules[m.key]) {
      const { value, error } = m.validate(fields[m.field] as never, ctx);
      fields[m.field] = value;
      if (error && source !== "error") {
        source = "error";
        reasoning = error;
      }
    } else {
      fields[m.field] = m.disabledValue();
    }
  }

  return { ...decision, fields, source, reasoning };
}

/**
 * Apply a decision via the registry: each enabled module runs its side
 * effects and may transform the system prompt. The prompt is threaded
 * through modules in registry order. Apply-time failures mark the decision
 * as an error and zero the offending field.
 *
 * @returns the final (possibly transformed) system prompt
 *
 * @internal — exported for testing.
 */
export async function applyDecision(decision: ScoutDecision, ctx: ScoutContext): Promise<string> {
  let systemPrompt = ctx.systemPrompt;

  for (const m of MODULES) {
    if (!ctx.config.modules[m.key]) continue;
    const res = await m.apply(decision.fields[m.field] as never, { ...ctx, systemPrompt });
    if (res?.systemPrompt !== undefined) systemPrompt = res.systemPrompt;
    if (res?.error) {
      decision.fields[m.field] = m.disabledValue();
      decision.source = "error";
      decision.reasoning = res.error;
    }
  }

  return systemPrompt;
}
