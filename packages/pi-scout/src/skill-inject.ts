/**
 * Skill interception and injection with description caching.
 *
 * Replaces pi's default skills section (verbose intro + all skills)
 * with a compact version containing only scout-selected skills.
 *
 * Description caching: skills already shown in a previous turn omit
 * their description (the LLM already has it in conversation history).
 * This significantly reduces per-turn token usage for recurring skills.
 */

/** Match pi's entire skills section: intro paragraph + XML block. */
const SKILLS_SECTION_RE =
  /\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/;

/** Track skill names already shown to the LLM in this session. */
let shownSkills: Set<string> = new Set();

/** Reset the cache — called on session_start. */
export function resetSkillCache(): void {
  shownSkills = new Set();
}

/**
 * Replace pi's default skills section with a compact, cached version.
 *
 * - First appearance of a skill: includes description
 * - Subsequent appearances: description omitted (LLM already has it)
 * - No skills selected: entire section removed
 *
 * @param systemPrompt - Full system prompt
 * @param selectedSkills - Skill names chosen by the side agent
 * @param allSkills - All loaded skills with their metadata
 * @returns Modified system prompt
 */
export function filterSkillsBlock(
  systemPrompt: string,
  selectedSkills: string[],
  allSkills: Array<{ name: string; description: string; filePath: string }>,
): string {
  if (selectedSkills.length === 0) {
    return systemPrompt.replace(SKILLS_SECTION_RE, "");
  }

  const skillMap = new Map(allSkills.map((s) => [s.name, s]));
  const entries: string[] = [];
  const newlyShown: string[] = [];

  for (const name of selectedSkills) {
    const skill = skillMap.get(name);
    if (!skill) continue;

    if (shownSkills.has(name)) {
      // Already introduced — compact form
      entries.push(`  <skill name="${esc(skill.name)}" location="${esc(skill.filePath)}" />`);
    } else {
      // First time — include description
      entries.push(
        `  <skill name="${esc(skill.name)}" location="${esc(skill.filePath)}">${esc(skill.description)}</skill>`,
      );
      newlyShown.push(name);
    }
  }

  if (entries.length === 0) {
    return systemPrompt.replace(SKILLS_SECTION_RE, "");
  }

  // Update cache
  for (const name of newlyShown) {
    shownSkills.add(name);
  }

  const compact = `\n\nActive skills (use \`read\` to load a skill's file):\n<available_skills>\n${entries.join("\n")}\n</available_skills>`;

  return systemPrompt.replace(SKILLS_SECTION_RE, compact);
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
