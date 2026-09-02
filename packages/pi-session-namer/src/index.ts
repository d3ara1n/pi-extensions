/**
 * pi-session-namer — Session naming with layered correction paths.
 *
 * L1: on the first user prompt of a new session, a lightweight side agent
 *     generates a concise title so the session is never "Untitled".
 * L2: `/namer:rename` regenerates from a conversation window (each turn
 *     pairs a user prompt with the assistant's closing reply) when the user
 *     finds the initial name stale.
 * L3: `rename_session` tool lets the main agent name the session on the
 *     user's request — the agent's context is the best naming source.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { Type } from "typebox";
import { DEFAULT_CONFIG } from "./types.ts";
import type { SessionNamerConfig } from "./types.ts";
import { loadNamerConfig } from "./config.ts";
import { cleanSessionName, generateSessionName, NAMING_RULES } from "./namer.ts";
import type { NamingTurn } from "./namer.ts";

export default function sessionNamerExtension(pi: ExtensionAPI) {
  let config: SessionNamerConfig = DEFAULT_CONFIG;
  let hasNamed = false;

  // ── session_start: load config, reset flag ──────────────────────
  pi.on("session_start", async (_event, _ctx) => {
    if (!_ctx.hasUI) return;
    config = loadNamerConfig(_ctx.cwd);
    hasNamed = false;

    // If the session already has a name (resume/fork/user-set), don't auto-name
    const existingName = pi.getSessionName();
    if (existingName) {
      hasNamed = true;
    }
  });

  // ── before_agent_start: auto-name on first prompt ───────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!ctx.hasUI) return;

    if (!config.enabled || hasNamed) return;

    // Skip empty prompts (e.g. image-only messages)
    if (!event.prompt?.trim()) return;

    // Mark as handled (no retry regardless of subsequent success/failure)
    hasNamed = true;

    // Name asynchronously so we don't block the main agent startup
    (async () => {
      let rolesApi: ModelRolesAPI;
      try {
        rolesApi = getModelRolesAPI();
      } catch {
        // model-roles missing is a config error scout will flag — skip silently
        return;
      }

      if (!rolesApi.resolveRole(config.sideAgentRole).model) {
        return;
      }

      try {
        const name = await generateSessionName(
          rolesApi,
          config.sideAgentRole,
          config,
          { turns: [{ user: event.prompt }] },
        );

        pi.setSessionName(name);
      } catch (err) {
        // Side agent failed (upstream error, empty response, or timeout on
        // the cheap utility model) — fall back to a truncated prompt title
        // and surface the reason in the TUI.
        const reason = err instanceof Error ? err.message : String(err);
        const fallback = event.prompt
          .slice(0, config.maxLength || undefined)
          .replace(/\n/g, " ")
          .trim();
        pi.setSessionName(fallback || "New session");
        ctx.ui.notify(`Session naming failed (${reason}) — using fallback title.`, "warning");
      }
    })().catch(() => {
      ctx.ui.notify("Session naming encountered an error.", "warning");
    });
  });

  // ── /namer — show status ────────────────────────────────────────
  pi.registerCommand("namer", {
    description: "Show session namer status and config",
    handler: async (_args, ctx) => {
      const currentName = pi.getSessionName();
      const lines = [
        `Session Namer: ${config.enabled ? "enabled" : "disabled"}`,
        `Side agent role: ${config.sideAgentRole}`,
        `Max length: ${config.maxLength}`,
        `Current name: ${currentName ?? "(none)"}`,
        `Has auto-named: ${hasNamed}`,
        "",
        "Session toggles: /namer:enable or /namer:disable",
        "Persistent config: set sessionNamer.enabled in settings.json",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("namer:enable", {
    description: "Enable session namer for the current session",
    handler: async (_args, ctx) => {
      config.enabled = true;
      ctx.ui.notify("Session Namer: enabled for this session", "info");
    },
  });

  pi.registerCommand("namer:disable", {
    description: "Disable session namer for the current session",
    handler: async (_args, ctx) => {
      config.enabled = false;
      ctx.ui.notify("Session Namer: disabled for this session", "info");
    },
  });

  // ── /namer:rename — regenerate from the user-message window ─────
  pi.registerCommand("namer:rename", {
    description: "Regenerate session name from the user's messages",
    handler: async (_args, ctx) => {
      const turns = collectTurns(ctx.sessionManager.getBranch());
      if (turns.length === 0) {
        ctx.ui.notify("No conversation available to generate a name from.", "warning");
        return;
      }

      let rolesApi: ModelRolesAPI;
      try {
        rolesApi = getModelRolesAPI();
      } catch {
        ctx.ui.notify("pi-model-roles not initialized. Cannot rename.", "error");
        return;
      }

      if (!rolesApi.resolveRole(config.sideAgentRole).model) {
        ctx.ui.notify(
          `Side agent role "${config.sideAgentRole}" not available. Cannot rename.`,
          "error",
        );
        return;
      }

      try {
        const name = await generateSessionName(
          rolesApi,
          config.sideAgentRole,
          config,
          { turns },
        );

        pi.setSessionName(name);
        ctx.ui.notify(`Session renamed: ${name}`, "info");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Rename failed: ${reason}`, "warning");
      }
    },
  });

  // ── rename_session tool — agent-driven naming on user request ───
  pi.registerTool({
    name: "rename_session",
    label: "Rename Session",
    description:
      "Set the current session's name — the label shown in the session list. Returns the normalized name actually set (long names are truncated to the configured max length).",
    promptSnippet: "Rename the current session",
    promptGuidelines: [
      "Call only when the user asks to name or rename the session — never rename proactively.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: ["The new session name — concise, in the user's language.", ...NAMING_RULES].join(" "),
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = cleanSessionName(params.name, config.maxLength);
      pi.setSessionName(name);
      ctx.ui.notify(`Session renamed: ${name}`, "info");
      return { content: [{ type: "text", text: `Session renamed to: ${name}` }], details: undefined };
    },
  });
}

/**
 * Collect naming turns from the active branch (root → leaf,
 * chronological), excluding entries on abandoned branches. Each user prompt
 * opens a turn, and the turn keeps only the LAST assistant text message of
 * the consecutive run that follows — the closing reply carries what was
 * actually found and done. Slash-command exchanges are skipped entirely
 * (prompt and any reply to it): they are session tooling, not user intent.
 * Tool-call blocks and tool-result entries carry no prose and never enter
 * a turn.
 *
 * Uses getBranch() rather than getEntries(): the session file is append-only,
 * so after re-editing the first message (resetLeaf → new root) the old root
 * still precedes the new one in getEntries() and would be picked by mistake.
 * Read live so it survives extension reloads (which reset closure state).
 *
 * @internal — exported for testing; command handlers consume it via the
 * session branch directly.
 */
export function collectTurns(entries: unknown[]): NamingTurn[] {
  const turns: NamingTurn[] = [];
  // Inside a slash-command exchange: its skipped prompt and any assistant
  // reply to it are dropped together.
  let inSlashExchange = false;
  for (const entry of entries as any[]) {
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role === "user") {
      // Empty text means image-only prompts or tool-result carriers — they
      // neither open a turn nor start a slash exchange.
      const text = extractEntryText(msg?.content).trim();
      if (!text) continue;
      if (text.startsWith("/")) {
        inSlashExchange = true;
        continue;
      }
      inSlashExchange = false;
      turns.push({ user: text });
    } else if (msg?.role === "assistant") {
      const text = extractEntryText(msg?.content).trim();
      if (!text || inSlashExchange) continue;
      // Reply before any prompt (rare) still carries substance — keep it as a
      // userless turn rather than dropping it.
      if (turns.length === 0) turns.push({ user: "" });
      turns[turns.length - 1].assistant = text;
    }
  }
  return turns;
}

/** Pull text out of a content field that may be a string or a ContentBlock[]. */
function extractEntryText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
  }
  return "";
}
