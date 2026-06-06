/**
 * Side agent invocation for session naming.
 *
 * Calls the side agent model using pi-ai's complete() function
 * and returns a cleaned session name string.
 */

import { complete } from "@earendil-works/pi-ai";
import type { SessionNamerConfig } from "./types.ts";

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
	sideModel: any,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	config: SessionNamerConfig,
	userPrompt: string,
): Promise<string> {
	const systemPrompt = buildNamerSystemPrompt(config.maxLength);

	// Truncate very long prompts to avoid wasting tokens
	const truncatedPrompt = userPrompt.length > 2000
		? userPrompt.slice(0, 2000) + "..."
		: userPrompt;

	const options: Record<string, any> = {
		maxTokens: 64,
	};

	if (apiKey) options.apiKey = apiKey;
	if (headers) options.headers = headers;

	try {
		const result = await complete(sideModel, {
			systemPrompt,
			messages: [{ role: "user", content: truncatedPrompt }],
		}, options);

		const raw = result.content
			?.filter((block: any) => block.type === "text")
			?.map((block: any) => block.text)
			?.join("")
			?.trim() ?? "";

		return cleanSessionName(raw, config.maxLength);
	} catch (err) {
		console.warn("[pi-session-namer] Side agent call failed:", err);
		// Fallback: truncate user prompt as name
		return userPrompt.slice(0, config.maxLength).replace(/\n/g, " ").trim();
	}
}

/**
 * Clean and truncate the generated name.
 */
function cleanSessionName(raw: string, maxLength: number): string {
	let name = raw.trim();

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

	// Truncate
	if (name.length > maxLength) {
		name = name.slice(0, maxLength - 3) + "...";
	}

	return name || "New session";
}
