/**
 * Side agent prompt construction — system prompt and user message.
 */

import type { ScoutConfig } from "./types.ts";

/** Previous turn context for better routing decisions. */
export interface PrevTurnContext {
  userPrompt: string;
  assistantSummary: string;
}

/**
 * Build the user message for the side agent.
 *
 * Includes previous turn context (when available) so the side agent can
 * understand follow-up prompts like "continue", "change that", etc.
 */
export function buildScoutUserMessage(
  userPrompt: string,
  currentRole: string,
  prevTurn?: PrevTurnContext,
): string {
  const parts: string[] = [];

  parts.push(`Current role: ${currentRole}`);

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
 * This is critical for Anthropic which requires a 1024-token minimum for
 * prompt caching to activate.
 */
export function buildScoutSystemPrompt(
  config: ScoutConfig,
  skillsList: string,
  rolesList: string,
): string {
  const parts: string[] = [];

  parts.push(
    `You are a scout. Analyze the user's request and decide which skills and model role to use.`,
  );
  parts.push(``);
  parts.push(`## Response Format`);
  parts.push(`Put your decision inside <decision> tags. Use exactly this line format:`);
  parts.push(`<decision>`);
  parts.push(`skills: skill-name-1, skill-name-2`);
  parts.push(`role: role-name-or-null`);
  parts.push(`reasoning: one sentence explanation`);
  parts.push(`</decision>`);
  parts.push(``);
  parts.push(`## Response Rules`);
  parts.push(`- skills: comma-separated skill names, or "none" if no skills needed`);
  parts.push(`- role: role name from the available list, or "null" to keep current`);
  parts.push(`- reasoning: one short sentence`);
  parts.push(`- NOTHING outside the <decision> tags. No quotes, no JSON, no markdown.`);
  parts.push(``);
  parts.push(`## Rules`);
  parts.push(`- Select at most ${config.maxSelectedSkills} skills. Select 0 if none are relevant.`);
  parts.push(`- Only select skills that will materially help with the task.`);
  parts.push(`- If the task is trivial (simple question, acknowledgment), select 0 skills.`);
  parts.push(`- "role" should be null if the current role is appropriate.`);
  parts.push(`- Only suggest a role change when the task clearly benefits from a different model.`);
  parts.push(`- Be conservative: prefer fewer skills and no role change when uncertain.`);
  parts.push(
    `- Use the Previous Turn context to understand follow-up requests (e.g. "continue", "change that", "no, the other one").`,
  );

  // Stable prefix ends here. Sections below are injected conditionally per
  // module toggle: a disabled module contributes no candidates, so the side
  // agent has nothing to choose from for it (and the application layer zeros
  // out its field regardless). The longer section (skills) comes first so
  // toggling the later module (roles) only invalidates the cache tail —
  // Anthropic prefix-cache matches the longest common prefix.
  if (config.modules.skillRouter) {
    parts.push(``);
    parts.push(`## Available Skills`);
    parts.push(skillsList || "(none)");
  }

  if (config.modules.modelRouter) {
    parts.push(``);
    parts.push(`## Available Roles`);
    parts.push(rolesList);
  }

  return parts.join("\n");
}
