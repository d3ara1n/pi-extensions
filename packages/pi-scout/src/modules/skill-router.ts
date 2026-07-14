/**
 * Skill-router module — decides which skills to inject.
 *
 * Self-describing: owns its prompt fragments, parsing, validation, status
 * rendering, and the skill-injection side effect. The engine never references
 * "skills" by name; it only iterates registered modules.
 */

import type { ScoutModule } from "../types.ts";
import { filterSkillsBlock } from "../skill-inject.ts";

/**
 * Parse the skills field: comma-separated names, "none" → empty.
 * @internal — exported for testing.
 */
export function parseSkills(raw: string): string[] {
  if (!raw || raw.toLowerCase() === "none") return [];
  return raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const skillRouterModule: ScoutModule<string[]> = {
  key: "skillRouter",
  field: "skills",
  noun: "skills",
  label: "skill-router",
  sectionTitle: "Available Skills",
  responseRule: '- skills: comma-separated skill names, or "none" if no skills needed',

  formatLine: () => "skills: skill-name-1, skill-name-2",

  rules: (ctx) => [
    `- Select at most ${ctx.config.maxSelectedSkills} skills. Select 0 if none are relevant.`,
    "- Only select skills that will materially help with the task.",
    "- If the task is trivial (simple question, acknowledgment), select 0 skills.",
  ],

  candidates: (ctx) => {
    if (ctx.skillEntries.length === 0) return "(none)";
    return ctx.skillEntries
      .map((s) => `- ${s.name}: ${s.description ?? "(no description)"}`)
      .join("\n");
  },

  promptContextLine: () => null,

  parse: (raw) => parseSkills(raw),

  validate: (value, ctx) => {
    const known = new Set(ctx.skillEntries.map((s) => s.name));
    let filtered = value.filter((name) => known.has(name));
    const max = ctx.config.maxSelectedSkills;
    if (max > 0) filtered = filtered.slice(0, max);
    return { value: filtered };
  },

  disabledValue: () => [],

  formatStatus: (value, ctx) => {
    if (!value || value.length === 0) return null;
    const names =
      value.length <= 3
        ? value.join(", ")
        : `${value.slice(0, 2).join(", ")} +${value.length - 2}`;
    return ctx.theme.fg("dim", "skills: ") + ctx.theme.fg("accent", names);
  },

  describe: (value) => (value.length > 0 ? value.join(", ") : "(none)"),

  apply: (value, ctx) => ({
    systemPrompt: filterSkillsBlock(ctx.systemPrompt, value, ctx.skillEntries),
  }),
};
