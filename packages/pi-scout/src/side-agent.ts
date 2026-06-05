/**
 * Side agent invocation logic.
 *
 * Calls the side agent model using pi-ai's complete() function
 * and parses the JSON decision response.
 */

import { complete } from "@earendil-works/pi-ai";
import type { ScoutDecision } from "./types.ts";
import { buildScoutUserMessage } from "./scout-prompt.ts";

/** Minimal type for side agent context — avoids importing pi-ai types directly. */
interface SideAgentContext {
	systemPrompt?: string;
	messages: Array<{ role: string; content: string }>;
}

/**
 * Call the side agent and return its decision.
 *
 * @param sideModel - The Model instance to use (from pi-model-roles "side" role)
 * @param apiKey - API key for the side model
 * @param headers - Custom headers for the side model
 * @param systemPrompt - Scout system prompt
 * @param userPrompt - The user's original prompt text
 * @param skillsList - Formatted list of available skills for the prompt
 * @param currentRole - Current active role name
 * @returns Parsed ScoutDecision, or a safe fallback on error
 */
export async function callSideAgent(
	sideModel: any,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	systemPrompt: string,
	userPrompt: string,
	skillsList: string,
	currentRole: string,
	rolesList: string,
): Promise<ScoutDecision> {
	const fallback: ScoutDecision = { skills: [], role: null, reasoning: "side agent error" };

	const context: SideAgentContext = {
		systemPrompt,
		messages: [
			{
				role: "user",
				content: buildScoutUserMessage(userPrompt, skillsList, currentRole, rolesList),
			},
		],
	};

	const options: Record<string, any> = {
		maxTokens: 256,
	};

	if (apiKey) options.apiKey = apiKey;
	if (headers) options.headers = headers;

	try {
		const result = await complete(sideModel, context, options);
		const text = result.content
			?.filter((block: any) => block.type === "text")
			?.map((block: any) => block.text)
			?.join("") ?? "";

		return parseDecision(text);
	} catch (err) {
		console.warn("[pi-scout] Side agent call failed:", err);
		return fallback;
	}
}

/**
 * Parse the side agent's JSON response into a ScoutDecision.
 * Tolerant of markdown wrapping, extra whitespace, etc.
 */
function parseDecision(raw: string): ScoutDecision {
	const fallback: ScoutDecision = { skills: [], role: null, reasoning: "parse error" };

	// Strip markdown code fences if present
	let text = raw.trim();
	if (text.startsWith("```")) {
		text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
	}

	try {
		const parsed = JSON.parse(text);

		return {
			skills: Array.isArray(parsed.skills)
				? parsed.skills.filter((s: any) => typeof s === "string")
				: [],
			role: typeof parsed.role === "string" && parsed.role !== "null"
				? parsed.role
				: null,
			reasoning: typeof parsed.reasoning === "string"
				? parsed.reasoning
				: "no reasoning provided",
		};
	} catch {
		console.warn("[pi-scout] Failed to parse side agent response:", raw.slice(0, 200));
		return fallback;
	}
}
