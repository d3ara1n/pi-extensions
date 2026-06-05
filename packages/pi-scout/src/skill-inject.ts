/**
 * Skill interception and injection.
 *
 * - Strips the <available_skills> XML block from the system prompt
 * - Reads selected skill files and injects their full content
 */

import * as fs from "node:fs";

/** Regex to match the entire <available_skills>...</available_skills> block. */
const SKILLS_XML_RE = /<available_skills>[\s\S]*?<\/available_skills>/g;

/**
 * Remove the <available_skills> XML block from the system prompt.
 * pi injects this block with skill metadata (name + description + location).
 * Scout replaces it with the actual skill content of selected skills only.
 */
export function stripSkillsBlock(systemPrompt: string): string {
	return systemPrompt.replace(SKILLS_XML_RE, "");
}

/**
 * Read the full SKILL.md content for selected skills.
 *
 * @param selectedSkills - Skill names chosen by the side agent
 * @param allSkills - All loaded skills with their file paths
 * @returns Injected skill content string, or empty string if nothing to inject
 */
export function readSkillContent(
	selectedSkills: string[],
	allSkills: Array<{ name: string; filePath: string }>,
): string {
	if (selectedSkills.length === 0) return "";

	const parts: string[] = [];

	for (const name of selectedSkills) {
		const skill = allSkills.find((s) => s.name === name);
		if (!skill?.filePath) continue;

		try {
			const content = fs.readFileSync(skill.filePath, "utf8").trim();
			if (content) {
				parts.push(`--- Skill: ${name} ---\n${content}`);
			}
		} catch {
			// Skill file not found or unreadable — skip
		}
	}

	return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
}
