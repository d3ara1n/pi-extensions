/**
 * pi-scout — Per-turn side agent decision framework.
 *
 * Before each conversation turn, a cheap side agent model analyzes the user prompt
 * and decides:
 * 1. Which skills to inject (skill-router module)
 * 2. Whether to switch model roles (model-router module)
 *
 * Both modules can be independently toggled via /scout:* commands.
 * Scout progress and results are shown in the status bar.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ScoutConfig, ScoutDecision } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { loadScoutConfig } from "./config.ts";
import { callSideAgent } from "./side-agent.ts";
import { buildScoutSystemPrompt, buildScoutUserMessage } from "./scout-prompt.ts";
import { filterSkillsBlock, resetSkillCache } from "./skill-inject.ts";
import { switchToRole } from "./model-switch.ts";
import { evaluateShortCircuit } from "./short-circuit.ts";

const STATUS_KEY = "scout";

/** Status-bar prefix: icon in its state color, the "scout:" label always dim. */
function scoutPrefix(icon: string, color: string, theme: any): string {
  return theme.fg(color, icon) + theme.fg("dim", " scout:") + " ";
}

/** Build a one-line status summary from a scout decision. */
function formatDecisionStatus(decision: ScoutDecision, theme: any): string {
  if (decision.source === "error") {
    return scoutPrefix("✗", "warning", theme) + theme.fg("warning", decision.reasoning);
  }

  if (decision.source === "short-circuit") {
    return scoutPrefix("✓", "success", theme) + theme.fg("dim", `(skipped) ${decision.reasoning}`);
  }

  const parts: string[] = [];

  if (decision.skills.length > 0) {
    const names =
      decision.skills.length <= 3
        ? decision.skills.join(", ")
        : `${decision.skills.slice(0, 2).join(", ")} +${decision.skills.length - 2}`;
    parts.push(theme.fg("dim", "skills: ") + theme.fg("accent", names));
  }
  if (decision.role) {
    parts.push(theme.fg("dim", "→ ") + theme.fg("warning", decision.role));
  }

  if (parts.length === 0) {
    return scoutPrefix("✓", "success", theme) + theme.fg("dim", "no changes");
  }

  return scoutPrefix("✓", "success", theme) + parts.join(theme.fg("dim", " | "));
}

export default function scoutExtension(pi: ExtensionAPI) {
  let config: ScoutConfig = DEFAULT_CONFIG;
  let lastDecision: ScoutDecision | undefined;

  /** Cache of previous turn context for better routing decisions. */
  let prevTurn: { userPrompt: string; assistantSummary: string } | undefined;

  function tryGetRolesApi(ctx: ExtensionContext): ModelRolesAPI | undefined {
    try {
      return getModelRolesAPI();
    } catch {
      ctx.ui.notify(
        "pi-model-roles not loaded. Ensure @d3ara1n/pi-model-roles is in extensions and restart.",
        "error",
      );
      return undefined;
    }
  }

  // ── /scout — show status ────────────────────────────────────────
  pi.registerCommand("scout", {
    description: "Show scout status and last decision",
    handler: async (_args, ctx) => {
      const rolesApi = tryGetRolesApi(ctx);
      const sideRole = rolesApi?.getRole(config.sideAgentRole);
      const lines = [
        `Scout: ${config.enabled ? "enabled" : "disabled"}`,
        `Side agent role: ${config.sideAgentRole} (${sideRole?.model ?? "current model"})`,
        ``,
        `Modules:`,
        `  skill-router: ${config.modules.skillRouter ? "on" : "off"}`,
        `  model-router: ${config.modules.modelRouter ? "on" : "off"}`,
        `  short-circuit: ${config.modules.shortCircuit ? "on" : "off"}`,
      ];

      if (lastDecision) {
        lines.push(``);
        lines.push(`Last decision:`);
        lines.push(
          `  skills: ${lastDecision.skills.length > 0 ? lastDecision.skills.join(", ") : "(none)"}`,
        );
        lines.push(`  role: ${lastDecision.role ?? "(no change)"}`);
        lines.push(`  reasoning: ${lastDecision.reasoning}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /scout:skill-router on/off ──────────────────────────────────
  pi.registerCommand("scout:skill-router", {
    description: "Toggle skill-router module (on/off)",
    handler: async (args, ctx) => {
      const value = (args ?? "").trim().toLowerCase();
      if (value === "on") {
        config.modules.skillRouter = true;
        ctx.ui.notify("Scout: skill-router enabled", "info");
      } else if (value === "off") {
        config.modules.skillRouter = false;
        ctx.ui.notify("Scout: skill-router disabled", "info");
      } else {
        ctx.ui.notify("Usage: /scout:skill-router on|off", "info");
      }
    },
  });

  // ── /scout:model-router on/off ──────────────────────────────────
  pi.registerCommand("scout:model-router", {
    description: "Toggle model-router module (on/off)",
    handler: async (args, ctx) => {
      const value = (args ?? "").trim().toLowerCase();
      if (value === "on") {
        config.modules.modelRouter = true;
        ctx.ui.notify("Scout: model-router enabled", "info");
      } else if (value === "off") {
        config.modules.modelRouter = false;
        ctx.ui.notify("Scout: model-router disabled", "info");
      } else {
        ctx.ui.notify("Usage: /scout:model-router on|off", "info");
      }
    },
  });

  // ── /scout:short-circuit on/off ─────────────────────────────────
  pi.registerCommand("scout:short-circuit", {
    description: "Toggle short-circuit module (on/off)",
    handler: async (args, ctx) => {
      const value = (args ?? "").trim().toLowerCase();
      if (value === "on") {
        config.modules.shortCircuit = true;
        ctx.ui.notify("Scout: short-circuit enabled", "info");
      } else if (value === "off") {
        config.modules.shortCircuit = false;
        ctx.ui.notify("Scout: short-circuit disabled", "info");
      } else {
        ctx.ui.notify("Usage: /scout:short-circuit on|off", "info");
      }
    },
  });

  // ── list_skills tool ───────────────────────────────────────────
  let cachedAllSkills: Array<{ name: string; description: string; filePath: string }> = [];

  pi.registerTool({
    name: "list_skills",
    label: "List all skills",
    description:
      "List all available skills with name and description. Use this when the user asks what skills are installed or you need to discover skills beyond those currently active.",
    parameters: { type: "object", properties: {}, required: [] } as any,
    async execute() {
      if (cachedAllSkills.length === 0) {
        return {
          content: [{ type: "text", text: "No skills available." }],
          details: undefined as any,
        };
      }
      const lines = cachedAllSkills.map((s) => `- **${s.name}**: ${s.description}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined as any };
    },
  });

  // ── session_start: load config ──────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    config = loadScoutConfig(ctx.cwd);
    resetSkillCache();
    prevTurn = undefined;
    cachedAllSkills = [];
  });

  // ── turn_end: cache assistant response for next turn's context ──
  pi.on("turn_end", async (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;

    // Extract text content, skip thinking blocks and tool calls
    const textParts: string[] = [];
    for (const block of msg.content) {
      if ("type" in block && block.type === "text" && "text" in block) {
        textParts.push(block.text);
      }
    }
    const fullText = textParts.join("");
    if (!fullText.trim()) return;

    // Truncate to avoid bloating the side agent context
    const MAX_SUMMARY = 500;
    const assistantSummary =
      fullText.length > MAX_SUMMARY ? fullText.slice(0, MAX_SUMMARY) + "..." : fullText;

    // before_agent_start already created/updated prevTurn with the user prompt.
    // We just fill in the assistant summary here.
    if (prevTurn) {
      prevTurn.assistantSummary = assistantSummary;
    }
  });

  // ── before_agent_start: core scout logic ────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!config.enabled) return;
    if (!config.modules.skillRouter && !config.modules.modelRouter) return;

    let rolesApi: ModelRolesAPI;
    try {
      rolesApi = getModelRolesAPI();
    } catch {
      ctx.ui.setStatus(
        STATUS_KEY,
        scoutPrefix("✗", "warning", ctx.ui.theme) +
          ctx.ui.theme.fg("warning", "model-roles missing"),
      );
      return;
    }

    const theme = ctx.ui.theme;

    // Skills available this turn — used by both the short-circuit layer
    // and the side-agent path.
    const skills = event.systemPromptOptions?.skills ?? [];
    if (cachedAllSkills.length === 0 && skills.length > 0) {
      cachedAllSkills = skills.map((s: any) => ({
        name: s.name,
        description: s.description ?? "",
        filePath: s.filePath,
      }));
    }
    const skillEntries = skills.map((s: any) => ({
      name: s.name,
      description: s.description ?? "",
      filePath: s.filePath,
    }));

    // ── Short-circuit layer ───────────────────────────────────
    // Skip the side model on trivial acknowledgments. A trivial ack means
    // "no skills, don't switch models" — both answers are certain, so this
    // is safe even with model-router on. Runs before model resolution to
    // save that cost too.
    if (config.modules.shortCircuit) {
      const skip = evaluateShortCircuit(event.prompt, config.shortCircuit);
      if (skip) {
        const decision: ScoutDecision = {
          skills: [],
          role: null,
          reasoning: skip.reasoning,
          source: "short-circuit",
        };
        lastDecision = decision;

        let systemPrompt = event.systemPrompt;
        if (config.modules.skillRouter) {
          systemPrompt = filterSkillsBlock(systemPrompt, [], skillEntries);
        }

        // Keep prevTurn current so the next turn still has context.
        prevTurn = { userPrompt: event.prompt, assistantSummary: "" };

        ctx.ui.setStatus(STATUS_KEY, formatDecisionStatus(decision, theme));
        if (systemPrompt !== event.systemPrompt) return { systemPrompt };
        return;
      }
    }

    // Show in-progress indicator
    ctx.ui.setStatus(STATUS_KEY, scoutPrefix("◎", "accent", theme) + theme.fg("dim", "scouting..."));

    // Resolve side agent model (sync — auth is resolved inside completeWithRole())
    const sideResolved = rolesApi.resolveRole(config.sideAgentRole);
    if (!sideResolved.model) {
      ctx.ui.setStatus(
        STATUS_KEY,
        scoutPrefix("✗", "warning", theme) + theme.fg("warning", "side model unavailable"),
      );
      return;
    }

    // Update status: resolving
    ctx.ui.setStatus(
      STATUS_KEY,
      scoutPrefix("◎", "accent", theme) +
        theme.fg("dim", "via ") +
        theme.fg("accent", `${sideResolved.model.provider}/${sideResolved.model.id}`) +
        theme.fg("dim", "..."),
    );

    // 1. Build the skills list for the side agent prompt
    const skillsList = skills
      .map((s: any) => `- ${s.name}: ${s.description ?? "(no description)"}`)
      .join("\n");

    // 2. Determine current role (use getCurrentRole: it recognizes the
    //    default role even when model=null, so the router has a real
    //    baseline instead of an opaque "unknown".)
    const currentModel = ctx.model;
    const currentRole = currentModel
      ? (rolesApi.getCurrentRole(`${currentModel.provider}/${currentModel.id}`) ?? "unknown")
      : "unknown";

    // 3. Build roles list
    const visibleRoles = rolesApi.getVisibleRoles();
    const rolesList = Object.entries(visibleRoles)
      .map(
        ([name, cfg]: [string, any]) =>
          `- ${name}: ${cfg.description ?? "(no description)"}${cfg.model ? ` (model: ${cfg.model})` : " (current model)"}`,
      )
      .join("\n");

    // 4. Build user message with conversation context
    const prevTurnContext = prevTurn?.assistantSummary
      ? { userPrompt: prevTurn.userPrompt, assistantSummary: prevTurn.assistantSummary }
      : undefined;
    const userMessage = buildScoutUserMessage(event.prompt, currentRole, prevTurnContext);

    // Reset prevTurn for the current turn — user prompt now, assistant filled by turn_end
    prevTurn = { userPrompt: event.prompt, assistantSummary: "" };

    // 5. Call side agent
    const scoutSystemPrompt = buildScoutSystemPrompt(config, skillsList, rolesList);
    const decision = await callSideAgent(
      rolesApi,
      config.sideAgentRole,
      scoutSystemPrompt,
      userMessage,
    );

    // Enforce module toggles at the application layer, regardless of what
    // the side agent returned. A disabled module's decision field is zeroed
    // so the status bar, /scout command, and apply logic all see clean
    // values (no misleading "→ fast" when model-router is off).
    if (!config.modules.modelRouter) decision.role = null;
    if (!config.modules.skillRouter) decision.skills = [];
    lastDecision = decision;

    let systemPrompt = event.systemPrompt;

    // 6. skill-router: filter skills XML to only selected ones
    if (config.modules.skillRouter) {
      systemPrompt = filterSkillsBlock(systemPrompt, decision.skills, skillEntries);
    }

    // 7. model-router: switch model if side agent recommends a different role
    if (config.modules.modelRouter && decision.role && decision.role !== currentRole) {
      const switched = await switchToRole(pi, decision.role, rolesApi);
      if (switched.ok) {
        const newModel = await rolesApi.resolveRoleAsync(decision.role);
        if (newModel?.model) {
          systemPrompt += `\n\n<current_model>${newModel.model.provider}/${newModel.model.id} (role: ${decision.role})</current_model>`;
        }
      } else {
        // Switch failed — reflect it in the status instead of the terminal.
        decision.role = null;
        decision.source = "error";
        decision.reasoning = switched.reason ?? "model switch failed";
      }
    }

    // 8. Show result in status bar
    ctx.ui.setStatus(STATUS_KEY, formatDecisionStatus(decision, theme));

    // 9. Return modified system prompt
    if (systemPrompt !== event.systemPrompt) {
      return { systemPrompt };
    }
  });
}
