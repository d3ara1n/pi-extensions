/**
 * pi-scout — Per-turn side agent decision framework.
 *
 * Scout is an engine over self-describing modules (see `modules/registry.ts`).
 * Before each conversation turn, a cheap side agent model analyzes the user
 * prompt and each enabled module contributes a decision (which skills to
 * inject, whether to switch roles, …). This file is module-agnostic: the
 * validate / apply / status phases iterate the registry, so new modules need
 * no edits here.
 *
 * Scout progress and results are shown in the status bar.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { ScoutConfig, ScoutContext, ScoutDecision, SkillEntry } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { loadScoutConfig } from "./config.ts";
import { callSideAgent } from "./side-agent.ts";
import { buildScoutSystemPrompt, buildScoutUserMessage } from "./scout-prompt.ts";
import { resetSkillCache } from "./skill-inject.ts";
import { evaluateShortCircuit } from "./short-circuit.ts";
import { MODULES, emptyFields } from "./modules/registry.ts";
import {
  scoutPrefix,
  formatDecisionStatus,
  normalizeDecision,
  applyDecision,
} from "./engine.ts";

const STATUS_KEY = "scout";

/** Widget key for the pending-prompt preview shown while the side agent runs. */
const PENDING_WIDGET_KEY = "scout-pending";

/** Collapse a prompt to one line, truncated for the pending widget. */
function previewPrompt(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** Widget lines shown above the editor while the side agent runs.
 *
 * pi renders the native user bubble only after `before_agent_start`
 * returns, so during the side-agent wait the chat is blank. This widget
 * mirrors the user's prompt so they get immediate feedback; it is
 * cleared in `finally` once the side agent returns, handing off to pi's
 * own user bubble.
 */
function buildPendingWidget(prompt: string, modelLabel: string, theme: any): string[] {
  return [
    theme.fg("accent", "◎") +
      theme.fg("dim", " scout analyzing via ") +
      theme.fg("accent", modelLabel) +
      theme.fg("dim", "…"),
    theme.fg("dim", "  › ") + theme.fg("muted", previewPrompt(prompt)),
  ];
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
        ...MODULES.map((m) => `  ${m.label}: ${config.modules[m.key] ? "on" : "off"}`),
        `  short-circuit: ${config.modules.shortCircuit ? "on" : "off"}`,
      ];

      if (lastDecision) {
        lines.push(``);
        lines.push(`Last decision:`);
        for (const m of MODULES) {
          lines.push(`  ${m.field}: ${m.describe(lastDecision.fields[m.field] as never)}`);
        }
        lines.push(`  reasoning: ${lastDecision.reasoning}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /scout:<label> on/off — generated per module ────────────────
  for (const m of MODULES) {
    pi.registerCommand(`scout:${m.label}`, {
      description: `Toggle ${m.label} module (on/off)`,
      handler: async (args, ctx) => {
        const value = (args ?? "").trim().toLowerCase();
        if (value === "on") {
          (config.modules as Record<string, boolean>)[m.key] = true;
          ctx.ui.notify(`Scout: ${m.label} enabled`, "info");
        } else if (value === "off") {
          (config.modules as Record<string, boolean>)[m.key] = false;
          ctx.ui.notify(`Scout: ${m.label} disabled`, "info");
        } else {
          ctx.ui.notify(`Usage: /scout:${m.label} on|off`, "info");
        }
      },
    });
  }

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
  let cachedAllSkills: SkillEntry[] = [];

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
    // Nothing to do if no routing module is enabled.
    if (!MODULES.some((m) => config.modules[m.key])) return;

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
    const skillEntries: SkillEntry[] = skills.map((s: any) => ({
      name: s.name,
      description: s.description ?? "",
      filePath: s.filePath,
    }));

    // Current main-model role (sync lookup — cheap).
    const currentModel = ctx.model;
    const currentRole = currentModel
      ? (rolesApi.getCurrentRole(`${currentModel.provider}/${currentModel.id}`) ?? "unknown")
      : "unknown";

    const scoutCtx: ScoutContext = {
      config,
      pi,
      rolesApi,
      skillEntries,
      currentRole,
      systemPrompt: event.systemPrompt,
      theme,
    };

    // ── Short-circuit layer ───────────────────────────────────
    // Skip the side model on trivial acknowledgments. A trivial ack means
    // "no skills, don't switch models" — both answers are certain, so this
    // is safe even with model-router on. Runs before model resolution to
    // save that cost too.
    if (config.modules.shortCircuit) {
      const skip = evaluateShortCircuit(event.prompt, config.shortCircuit);
      if (skip) {
        const decision: ScoutDecision = {
          fields: emptyFields(),
          reasoning: skip.reasoning,
          source: "short-circuit",
        };
        // Unified apply phase: skill-router removes the skills section,
        // model-router no-ops on null. Both are safe for a trivial ack.
        const systemPrompt = await applyDecision(decision, scoutCtx);
        lastDecision = decision;
        prevTurn = { userPrompt: event.prompt, assistantSummary: "" };
        ctx.ui.setStatus(STATUS_KEY, formatDecisionStatus(decision, scoutCtx));
        if (systemPrompt !== event.systemPrompt) return { systemPrompt };
        return;
      }
    }

    // Show in-progress indicator
    ctx.ui.setStatus(
      STATUS_KEY,
      scoutPrefix("◎", "accent", theme) + theme.fg("dim", "scouting..."),
    );

    // Resolve side agent model (sync — auth is resolved inside completeWithRole())
    const sideResolved = rolesApi.resolveRole(config.sideAgentRole);
    if (!sideResolved.model) {
      ctx.ui.setStatus(
        STATUS_KEY,
        scoutPrefix("✗", "warning", theme) + theme.fg("warning", "side model unavailable"),
      );
      return;
    }

    // Build prompts from the registry, then call the side agent.
    const scoutSystemPrompt = buildScoutSystemPrompt(scoutCtx);
    const prevTurnContext = prevTurn?.assistantSummary
      ? { userPrompt: prevTurn.userPrompt, assistantSummary: prevTurn.assistantSummary }
      : undefined;
    const userMessage = buildScoutUserMessage(event.prompt, prevTurnContext, scoutCtx);

    // Reset prevTurn for the current turn — user prompt now, assistant filled by turn_end
    prevTurn = { userPrompt: event.prompt, assistantSummary: "" };

    let decision: ScoutDecision;
    try {
      // Mirror the user's prompt above the editor while the side agent
      // runs (see buildPendingWidget). Cleared in finally so the prompt
      // isn't shown twice once pi renders its own user bubble.
      ctx.ui.setWidget(
        PENDING_WIDGET_KEY,
        buildPendingWidget(
          event.prompt,
          `${sideResolved.model.provider}/${sideResolved.model.id}`,
          theme,
        ),
      );
      decision = await callSideAgent(
        rolesApi,
        config.sideAgentRole,
        scoutSystemPrompt,
        userMessage,
      );
    } finally {
      ctx.ui.setWidget(PENDING_WIDGET_KEY, undefined);
    }

    // Validate + zero via the registry, then apply.
    decision = normalizeDecision(decision, scoutCtx);
    const systemPrompt = await applyDecision(decision, scoutCtx);
    lastDecision = decision;

    // Show result in status bar
    ctx.ui.setStatus(STATUS_KEY, formatDecisionStatus(decision, scoutCtx));

    // Surface the full error cause via notify — the status line only carries
    // the short category (see formatDecisionStatus / decision.reasoning).
    if (decision.source === "error" && decision.errorDetail) {
      ctx.ui.notify(`scout: ${decision.errorDetail}`, "warning");
    }

    // Return modified system prompt
    if (systemPrompt !== event.systemPrompt) {
      return { systemPrompt };
    }
  });
}
