/**
 * Side agent prompt construction — system prompt and user message.
 *
 * Both are assembled by iterating the registered modules, so enabling /
 * disabling a module (or adding a new one) needs no edits here. A disabled
 * module contributes no format line, no rule, no candidate section, and no
 * context line — the model is never even told the concept exists.
 */

import type { ScoutContext } from "./types.ts";
import { enabledModules } from "./modules/registry.ts";

/** Previous turn context for better routing decisions. */
export interface PrevTurnContext {
  userPrompt: string;
  assistantSummary: string;
}

/**
 * Build the user message for the side agent.
 *
 * Module context lines (e.g. "Current role: …") come first, then previous-turn
 * context (when available) so the side agent can understand follow-ups like
 * "continue", "change that", etc.
 */
export function buildScoutUserMessage(
  userPrompt: string,
  prevTurn: PrevTurnContext | undefined,
  ctx: ScoutContext,
): string {
  const parts: string[] = [];

  for (const m of enabledModules(ctx.config)) {
    const line = m.promptContextLine(ctx);
    if (line) parts.push(line);
  }

  if (prevTurn && (prevTurn.userPrompt || prevTurn.assistantSummary)) {
    parts.push(``);
    parts.push(`## Previous Turn`);
    if (prevTurn.userPrompt) {
      parts.push(`User: ${prevTurn.userPrompt}`);
    }
    if (prevTurn.assistantSummary) {
      parts.push(`Assistant: ${prevTurn.assistantSummary}`);
    }
  }

  parts.push(``);
  parts.push(`## Current User Prompt`);
  parts.push(userPrompt);

  return parts.join("\n");
}

/**
 * Build the system prompt for the side agent.
 *
 * Stable per-session data (skills, roles) is embedded here rather than in the
 * user message so that the entire system prompt forms a large, cacheable prefix.
 */
export function buildScoutSystemPrompt(ctx: ScoutContext): string {
  const mods = enabledModules(ctx.config);
  const parts: string[] = [];

  const nouns = mods.map((m) => m.noun).join(" and ");
  parts.push(`You are a scout. Analyze the user's request and decide which ${nouns} to use.`);
  parts.push(``);

  // ── Response Format ───────────────────────────────────────────
  parts.push(`## Response Format`);
  parts.push(`Put your decision inside <decision> tags. Use exactly this line format:`);
  parts.push(`<decision>`);
  for (const m of mods) parts.push(m.formatLine(ctx));
  parts.push(`reasoning: one sentence explanation`);
  parts.push(`</decision>`);
  parts.push(``);

  // ── Response Rules ────────────────────────────────────────────
  parts.push(`## Response Rules`);
  for (const m of mods) parts.push(m.responseRule);
  parts.push(`- reasoning: one short sentence`);
  parts.push(`- NOTHING outside the <decision> tags. No quotes, no JSON, no markdown.`);
  parts.push(``);

  // ── Rules ─────────────────────────────────────────────────────
  parts.push(`## Rules`);
  parts.push(`- Be conservative: prefer fewer selections when uncertain.`);
  parts.push(
    `- Use the Previous Turn context to understand follow-up requests (e.g. "continue", "change that", "no, the other one").`,
  );
  for (const m of mods) {
    for (const rule of m.rules(ctx)) parts.push(rule);
  }

  // ── Available sections (registry order = cache-friendly) ──────
  for (const m of mods) {
    const candidates = m.candidates(ctx);
    if (candidates != null) {
      parts.push(``);
      parts.push(`## ${m.sectionTitle}`);
      parts.push(candidates);
    }
  }

  return parts.join("\n");
}
