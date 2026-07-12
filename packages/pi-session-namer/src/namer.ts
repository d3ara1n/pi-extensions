/**
 * Side agent invocation for session naming.
 *
 * Calls the side agent via model-roles' completeWithRole() (auth resolved internally)
 * and returns a cleaned session name string.
 */

import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { SessionNamerConfig } from "./types.ts";

/** Hard timeout for the naming side agent (ms). A short title needs ~dozens of tokens. */
const NAMER_TIMEOUT_MS = 10_000;

/**
 * Build the system prompt for the naming side agent.
 */
export function buildNamerSystemPrompt(maxLength: number): string {
  return [
    `You are a session naming assistant. Generate a concise title for a coding session based on the user's first message.`,
    ``,
    `Rules:`,
    `- Output in the SAME language as the user's message`,
    `- Maximum ${maxLength} characters`,
    `- Output ONLY the title, no quotes, no prefix, no explanation`,
    `- Summarize intent, do not copy the original message verbatim`,
    `- If the message mentions specific files, modules, or functions, keep those names`,
    `- Be specific: "Fix auth token refresh bug" is better than "Fix a bug"`,
  ].join("\n");
}

/**
 * Call the side agent to generate a session name.
 */
export async function generateSessionName(
  rolesApi: ModelRolesAPI,
  roleName: string,
  config: SessionNamerConfig,
  userPrompt: string,
): Promise<string> {
  const systemPrompt = buildNamerSystemPrompt(config.maxLength);

  // Truncate very long prompts to avoid wasting tokens
  const truncatedPrompt = userPrompt.length > 2000 ? userPrompt.slice(0, 2000) + "..." : userPrompt;

  const signal = AbortSignal.timeout(NAMER_TIMEOUT_MS);
  const result = await rolesApi.completeWithRole(
    roleName,
    {
      systemPrompt,
      messages: [{ role: "user", content: truncatedPrompt, timestamp: Date.now() }],
    },
    { signal },
  );

  const raw =
    result.content
      ?.filter((block: any) => block.type === "text")
      ?.map((block: any) => block.text)
      ?.join("")
      ?.trim() ?? "";

  return cleanSessionName(raw, config.maxLength);
}

/**
 * Clean and truncate the generated name.
 * Strips common model prefixes ("Here is a title:", "Title:", etc.)
 * so the output can be used directly.
 */
function cleanSessionName(raw: string, maxLength: number): string {
  let name = raw.trim();
  if (!name) return "New session";

  // Strip common model prefixes that slip through
  name = name.replace(/^(here is (a |the )?(title|name)[：:]\s*)/i, "");
  name = name.replace(/^(title|name|session)[：:]\s*/i, "");

  // Strip surrounding quotes if present
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'")) ||
    (name.startsWith("「") && name.endsWith("」"))
  ) {
    name = name.slice(1, -1);
  }

  // Remove newlines
  name = name.replace(/\n/g, " ").trim();

  // Truncate only when a positive limit is configured. For limits shorter
  // than an ellipsis, preserve the hard maximum instead of overflowing it.
  if (maxLength > 0 && name.length > maxLength) {
    name = maxLength <= 3 ? name.slice(0, maxLength) : name.slice(0, maxLength - 3) + "...";
  }

  return name || "New session";
}
