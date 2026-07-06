/**
 * Side agent invocation logic.
 *
 * Calls the side agent via model-roles' complete() (auth resolved internally)
 * and parses the JSON decision response.
 */

import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ScoutDecision } from "./types.ts";

/** Minimal type for side agent context — matches pi-ai's Context interface. */
interface SideAgentContext {
  systemPrompt?: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

/**
 * Call the side agent and return its decision.
 *
 * @param rolesApi - ModelRolesAPI (provides complete() with auth resolved internally)
 * @param roleName - Role name whose model + auth to use (from scout config)
 * @param systemPrompt - Scout system prompt (includes skills/roles for cache friendliness)
 * @param userMessage - Fully assembled user message (includes context, current role, user prompt)
 * @returns Parsed ScoutDecision, or a safe fallback on error
 */
export async function callSideAgent(
  rolesApi: ModelRolesAPI,
  roleName: string,
  systemPrompt: string,
  userMessage: string,
): Promise<ScoutDecision> {
  const fallback: ScoutDecision = {
    skills: [],
    role: null,
    reasoning: "side agent error",
    source: "side-agent",
  };

  const context: SideAgentContext = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: userMessage,
        timestamp: Date.now(),
      },
    ],
  };

  try {
    const result = await rolesApi.complete(roleName, context, {
      cacheRetention: "short",
    });
    const text =
      result.content
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
  const fallback: ScoutDecision = {
    skills: [],
    role: null,
    reasoning: "parse error",
    source: "side-agent",
  };

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
      role: typeof parsed.role === "string" && parsed.role !== "null" ? parsed.role : null,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "no reasoning provided",
      source: "side-agent",
    };
  } catch {
    console.warn("[pi-scout] Failed to parse side agent response:", raw.slice(0, 200));
    return fallback;
  }
}
