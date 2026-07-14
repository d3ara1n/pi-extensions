/**
 * pi-session-namer — Auto-name pi sessions using a cheap side agent.
 *
 * On the first user prompt of a new session, calls a lightweight side agent
 * to generate a concise session title, then sets it via pi.setSessionName().
 * Subsequent turns are skipped with near-zero overhead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { DEFAULT_CONFIG } from "./types.ts";
import type { SessionNamerConfig } from "./types.ts";
import { loadNamerConfig } from "./config.ts";
import { generateSessionName } from "./namer.ts";

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
          event.prompt,
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

  // ── /namer:rename — force regenerate ────────────────────────────
  pi.registerCommand("namer:rename", {
    description: "Regenerate session name from the last user prompt",
    handler: async (_args, ctx) => {
      const lastUserPrompt = getLastUserPrompt(ctx.sessionManager.getEntries());
      if (!lastUserPrompt?.trim()) {
        ctx.ui.notify("No user prompt available to generate a name from.", "warning");
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
          lastUserPrompt,
        );

        pi.setSessionName(name);
        ctx.ui.notify(`Session renamed: ${name}`, "info");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Rename failed: ${reason}`, "warning");
      }
    },
  });
}

/**
 * Extract the most recent user message text from session entries.
 *
 * Read live from the session manager rather than a cached variable, so it
 * survives extension reloads (which reset closure state).
 */
function getLastUserPrompt(entries: unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role !== "user") continue;
    const text = extractEntryText(msg.content);
    if (text.trim()) return text;
  }
  return undefined;
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
