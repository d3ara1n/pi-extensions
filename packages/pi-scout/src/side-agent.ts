/**
 * Side agent invocation logic.
 *
 * Calls the side agent via model-roles' completeWithRole() (auth resolved
 * internally) and parses the <decision> response. Parsing is module-agnostic:
 * it extracts any registered module's field by name and dispatches to that
 * module's `parse()`, so new fields are recognized without edits here.
 */

import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ScoutDecision } from "./types.ts";
import { MODULES, emptyFields } from "./modules/registry.ts";

/** Field names the parser recognizes (registered modules + "reasoning"). */
const FIELD_RE = /^([A-Za-z_][\w-]*)\s*[:：]\s*(.*)$/;

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

    // Surface upstream errors honestly. Providers can return a result with
    // stopReason "error" + errorMessage and empty content WITHOUT throwing
    // (e.g. a gateway returning "all nodes failed to stream"). Without this
    // check the empty content misleads as "unparseable response", hiding the
    // real cause in the status bar.
    if (result.stopReason === "error" || result.errorMessage) {
      return {
        fields: emptyFields(),
        reasoning: `failed: ${shortError(result.errorMessage || "upstream error")}`,
        source: "error",
      };
    }

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
    return { fields: emptyFields(), reasoning, source: "error" };
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
 * 2. Falls back to scanning the entire raw text for field lines — handles
 *    models that ignore the tag instructions.
 * 3. Returns "unparseable response" only when neither approach finds any
 *    recognized field.
 *
 * Recognized fields come from the module registry, so a new module's field
 * is parsed automatically once the module is registered.
 */
export function parseDecision(raw: string): ScoutDecision {
  const fallback: ScoutDecision = {
    fields: emptyFields(),
    reasoning: "unparseable response",
    source: "error",
  };

  const text = raw.trim();
  if (!text) return fallback;

  // ── Stage 1: <decision> tag extraction ──────────────────
  const tagMatch = text.match(/<decision>([\s\S]*?)<\/decision>/);
  if (tagMatch) {
    const fromTag = parseTextFields(tagMatch[1]);
    if (fromTag) return fromTag;
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
  const fields: Record<string, unknown> = {};
  let reasoning = "";

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(FIELD_RE);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const value = match[2].trim();

    const mod = MODULES.find((m) => m.field === key);
    if (mod) {
      if (fields[mod.field] === undefined) fields[mod.field] = mod.parse(value);
    } else if (key === "reasoning") {
      reasoning = reasoning || value;
    }
  }

  // At least one recognized field — build decision
  if (Object.keys(fields).length > 0 || reasoning) {
    // Fill any missing module fields with their disabled value so downstream
    // code always sees a complete fields record.
    for (const m of MODULES) {
      if (fields[m.field] === undefined) fields[m.field] = m.disabledValue();
    }
    return {
      fields,
      reasoning: reasoning || "no reasoning provided",
      source: "side-agent",
    };
  }

  return null;
}
