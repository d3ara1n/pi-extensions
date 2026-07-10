/**
 * Side agent invocation logic.
 *
 * Calls the side agent via model-roles' completeWithRole() (auth resolved
 * internally) and parses the <decision> response (line-based key: value).
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
 * @param rolesApi - ModelRolesAPI (provides completeWithRole() with auth resolved internally)
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
    const result = await rolesApi.completeWithRole(roleName, context, {
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
 * Parse the side agent's text response into a ScoutDecision.
 *
 * The prompt instructs the model to use a line-based format inside
 * <decision> tags (no JSON). This parser:
 *
 * 1. Extracts from <decision>...</decision> tags — precise, ignores
 *    any surrounding prose or markdown noise.
 * 2. Falls back to scanning the entire raw text for "skills:",
 *    "role:", "reasoning:" lines — handles models that ignore both
 *    the tag and JSON instructions.
 * 3. Returns "unparseable response" only when neither approach
 *    finds any decision fields.
 */
function parseDecision(raw: string): ScoutDecision {
  const fallback: ScoutDecision = {
    skills: [],
    role: null,
    reasoning: "unparseable response",
    source: "error",
  };

  const text = raw.trim();
  if (!text) return fallback;

  // ── Stage 1: <decision> tag extraction ─────────────────
  const tagMatch = text.match(/<decision>([\s\S]*?)<\/decision>/);
  if (tagMatch) {
    const decision = parseTextFields(tagMatch[1]);
    if (decision) return decision;
  }

  // ── Stage 2: scan entire text for field lines ───────────
  const fromFull = parseTextFields(text);
  if (fromFull) return fromFull;

  return fallback;
}

/**
 * Parse "key: value" lines from a text block into a ScoutDecision.
 * Returns null if no recognized fields are found.
 */
function parseTextFields(block: string): ScoutDecision | null {
  const lines = block.split("\n");
  let skillsRaw = "";
  let roleRaw = "";
  let reasoningRaw = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match "key: value" (supports both ASCII and full-width colon)
    const match = trimmed.match(/^(skills?|role|reasoning)\s*[:：]\s*(.*)$/i);
    if (match) {
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      if (key.startsWith("skill")) skillsRaw = skillsRaw || value;
      else if (key === "role") roleRaw = roleRaw || value;
      else if (key === "reasoning") reasoningRaw = reasoningRaw || value;
    }
  }

  // At least one field recognized — build decision
  if (skillsRaw || roleRaw || reasoningRaw) {
    const skills = parseSkillsField(skillsRaw);
    const role = parseRoleField(roleRaw);
    const reasoning = reasoningRaw || "no reasoning provided";
    return { skills, role, reasoning, source: "side-agent" };
  }

  return null;
}

/** Parse the skills field: comma-separated names, "none" → empty. */
function parseSkillsField(raw: string): string[] {
  if (!raw || raw.toLowerCase() === "none") return [];
  return raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse the role field: "null" / "none" / "current" → null, otherwise the role name. */
function parseRoleField(raw: string): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (lower === "null" || lower === "none" || lower === "current" || lower === "keep") {
    return null;
  }
  return raw.trim() || null;
}
