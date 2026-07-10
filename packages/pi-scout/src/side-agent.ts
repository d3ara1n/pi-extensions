/**
 * Side agent invocation logic.
 *
 * Calls the side agent via model-roles' complete() (auth resolved internally)
 * and parses the JSON decision response.
 */

import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ScoutDecision } from "./types.ts";

/**
 * Hard timeout (ms) for every side-agent call. Scout runs before each
 * main-model turn, so a hung side model would block the whole conversation.
 * 15s is ample for skill/model routing on any reasonable model; if it
 * elapses the request is aborted and scout falls back to a safe no-op
 * decision (no skills, no model switch) so the main turn still proceeds.
 */
const SIDE_AGENT_TIMEOUT_MS = 15_000;

/** Minimal type for side agent context — matches pi-ai's Context interface. */
interface SideAgentContext {
  systemPrompt?: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

/** Short, status-bar-friendly message extracted from an unknown error. */
function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 80 ? msg.slice(0, 77) + "..." : msg;
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

  // Self-managing 15s abort: pi-ai forwards `signal` to the underlying fetch,
  // so a timeout actually cancels the HTTP request instead of orphaning it.
  const signal = AbortSignal.timeout(SIDE_AGENT_TIMEOUT_MS);
  try {
    const result = await rolesApi.complete(roleName, context, {
      cacheRetention: "short",
      signal,
    });
    const text =
      result.content
        ?.filter((block: any) => block.type === "text")
        ?.map((block: any) => block.text)
        ?.join("") ?? "";

    return parseDecision(text);
  } catch (err) {
    // Surface the failure category in the status bar; scout falls back to a
    // safe no-op decision either way.
    const reasoning = signal.aborted
      ? `timed out (${SIDE_AGENT_TIMEOUT_MS / 1000}s)`
      : `failed: ${shortError(err)}`;
    return { skills: [], role: null, reasoning, source: "error" };
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
    reasoning: "unparseable response",
    source: "error",
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
    return fallback;
  }
}
