/**
 * Side agent system prompt — instructs the model to return a structured JSON decision.
 */

import type { ScoutConfig } from "./types.ts";

/**
 * Build the user message for the side agent.
 * Includes the user's prompt, available skills, and current role.
 */
export function buildScoutUserMessage(
	userPrompt: string,
	skillsList: string,
	currentRole: string,
): string {
	return [
		`User prompt:`,
		userPrompt,
		``,
		`Available skills:`,
		skillsList || "(none)",
		``,
		`Current role: ${currentRole}`,
	].join("\n");
}

/**
 * Build the system prompt for the side agent.
 */
export function buildScoutSystemPrompt(config: ScoutConfig): string {
	const parts: string[] = [];

	parts.push(`You are a scout. Analyze the user's request and decide which skills and model role to use.`);
	parts.push(``);
	parts.push(`## Response Format`);
	parts.push(`Respond with ONLY a JSON object, no markdown, no explanation outside the JSON:`);
	parts.push(`{`);
	parts.push(`  "skills": ["skill-name-1", "skill-name-2"],`);
	parts.push(`  "role": "role-name-or-null",`);
	parts.push(`  "reasoning": "one sentence explanation"`);
	parts.push(`}`);
	parts.push(``);
	parts.push(`## Rules`);
	parts.push(`- Select at most ${config.maxSelectedSkills} skills. Select 0 if none are relevant.`);
	parts.push(`- Only select skills that will materially help with the task.`);
	parts.push(`- If the task is trivial (simple question, acknowledgment), select 0 skills.`);
	parts.push(`- "role" should be null if the current role is appropriate.`);
	parts.push(`- Only suggest a role change when the task clearly benefits from a different model.`);
	parts.push(`- Be conservative: prefer fewer skills and no role change when uncertain.`);

	if (!config.modules.modelRouter) {
		parts.push(`- IMPORTANT: model routing is disabled. Always return role: null.`);
	}

	if (!config.modules.skillRouter) {
		parts.push(`- IMPORTANT: skill routing is disabled. Always return skills: [].`);
	}

	return parts.join("\n");
}
