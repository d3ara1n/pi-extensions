/**
 * pi-subagent — Role-based subagent orchestration with TUI rendering.
 *
 * Delegates tasks to specialized pi child processes with:
 * - Real-time progress streaming via TUI (tool calls, turns, elapsed time)
 * - AI-generated one-line summary for compact display (configurable role)
 * - All messages collected for expanded view (Ctrl+O)
 * - Accurate, concise output for the main model
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ModelRolesAPI, ThinkingLevel } from "@d3ara1n/pi-model-roles";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { SubagentConfig, SubagentResult, SubagentRole } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { loadSubagentConfig } from "./config.ts";
import { BUILTIN_ROLES } from "./roles.ts";
import { spawnSubagent, getPiInvocation } from "./spawn.ts";
import {
  MAX_OUTPUT_CHARS,
  formatTokens,
  AsyncSemaphore,
  isProviderError,
  effectiveTimeout,
} from "./utils.ts";
import { persistSubagentHistory } from "./history.ts";
import { compressOutput, generateSummary } from "./output.ts";
import { renderDelegateCall, renderDelegateResult } from "./render.ts";

// ── Helpers ────────────────────────────────────────────────────

/** Coalesce bursty progress events so the TUI repaints at most this often. */
const PROGRESS_THROTTLE_MS = 50;

// ── Extension entry ────────────────────────────────────────────────

export default function subagentExtension(pi: ExtensionAPI) {
  let config: SubagentConfig = DEFAULT_CONFIG;
  let concurrencyGate = new AsyncSemaphore(DEFAULT_CONFIG.maxConcurrency);

  // If spawned as a child by a parent subagent, PI_SUBAGENT_ALLOWED restricts
  // which roles are available. Filter before any tool description sees them.
  const ALLOWLIST: string[] | undefined = (() => {
    const raw = process.env.PI_SUBAGENT_ALLOWED;
    if (!raw) return undefined;
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  })();

  // Nesting depth: 0 in the top-level session, incremented via PI_SUBAGENT_DEPTH
  // for each child. Bounds how deeply subagents may spawn their own subagents.
  const CURRENT_DEPTH: number = (() => {
    const raw = process.env.PI_SUBAGENT_DEPTH;
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();

  const availableRoles: Record<string, SubagentRole> = {};
  for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
    if (!ALLOWLIST || ALLOWLIST.includes(name)) {
      availableRoles[name] = role;
    }
  }

  // Mutable guidelines array — rebuilt in session_start to reflect agentOverrides
  const guidelines: string[] = [];

  function rebuildGuidelines(roles: Record<string, SubagentRole>): void {
    const entries = Object.entries(roles);
    const exampleLines: string[] = [];
    const decisionLines: string[] = [];

    for (const [name, role] of entries) {
      // Decision flow
      decisionLines.push(`  ${role.decisionTrigger} → delegate(${name})`);

      // Concrete examples — one line per role with comma-separated examples
      const quotedExamples = role.examples.map((e) => `"${e}"`).join(", ");
      exampleLines.push(`  delegate(${name}):  ${quotedExamples}`);
    }

    guidelines.length = 0;
    guidelines.push(
      "WHEN TO DELEGATE — offload substantial work when you only need the result:",
      "",
      "- Delegate ONLY when a task involves significant work (heavy analysis, multi-step investigation, large-scope changes) AND you only care about the conclusion, not intermediate steps.",
      "- DO NOT delegate simple tasks: a single read, a one-line edit, a basic grep. Just do them yourself.",
      "- DO NOT delegate straightforward file modifications touching 1-2 files. Use edit/write directly.",
      "- Delegation has overhead (spawning a child process). Reserve it for tasks that would genuinely clutter your context with 3+ turns of raw tool output.",
      "",
      "AVAILABLE ROLES:",
      ...entries.map(([name, role]) => `  - ${name}: ${role.description}`),
      "",
      "DECISION FLOW (which role for what):",
      "",
      ...decisionLines,
      "",
      "CONCRETE EXAMPLES of good delegation targets:",
      "",
      ...exampleLines,
      "",
      "For multiple independent substantial tasks, emit multiple delegate calls in one turn — they run in parallel.",
      "Include ALL necessary context — subagents have no access to this conversation.",
      'Pass reference files via the `files` parameter (e.g. files: ["src/auth.ts"]) instead of pasting their contents into `context` — the subagent reads them directly without consuming your context window.',
      'Override the model per-call with the `model` parameter for one-off vision or model-specific jobs.',
    );
  }

  // Apply agent overrides on top of built-in roles
  function applyAgentOverrides(
    roles: Record<string, SubagentRole>,
    overrides: Record<string, Partial<SubagentRole> & { disabled?: boolean }>,
  ): void {
    for (const [name, override] of Object.entries(overrides)) {
      if (override.disabled) {
        delete roles[name];
      } else if (roles[name]) {
        roles[name] = { ...roles[name], ...override };
      } else {
        // Custom role — must provide all required fields (validated in session_start)
        roles[name] = override as SubagentRole;
      }
    }
  }

  // Initial guidelines from built-in roles
  rebuildGuidelines(availableRoles);

  pi.on("session_start", async (_event, ctx) => {
    config = loadSubagentConfig(ctx.cwd);
    concurrencyGate = new AsyncSemaphore(config.maxConcurrency);

    // Rebuild from BUILTIN_ROLES (respecting ALLOWLIST) so repeated
    // session_start is idempotent — overrides from prior sessions don't accumulate.
    for (const key of Object.keys(availableRoles)) delete availableRoles[key];
    for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
      if (!ALLOWLIST || ALLOWLIST.includes(name)) {
        availableRoles[name] = role;
      }
    }

    applyAgentOverrides(availableRoles, config.agentOverrides);

    // Validate custom roles (skip built-in roles — they already have all fields)
    const REQUIRED_FIELDS = [
      "role",
      "description",
      "examples",
      "decisionTrigger",
      "tools",
      "systemPrompt",
    ] as const;
    for (const [name, role] of Object.entries(availableRoles)) {
      if (name in BUILTIN_ROLES) continue;
      const missing = REQUIRED_FIELDS.filter((f) => !(f in (role as any)));
      if (missing.length > 0) {
        delete availableRoles[name];
        ctx.ui.notify(
          `[pi-subagent] Custom role "${name}" skipped — missing: ${missing.join(", ")}. Required: ${REQUIRED_FIELDS.join(", ")}.`,
          "error",
        );
      }
    }

    rebuildGuidelines(availableRoles);
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate to subagent",
    description:
      "Offload work to a specialized subagent to keep your own context clean and focused. Prefer this over doing work yourself when a task would generate many tool calls or verbose output. Subagents have isolated context — include all necessary info in the task description.",
    promptSnippet: "Delegate tasks to specialized subagents",
    promptGuidelines: guidelines,

    parameters: Type.Object({
      role: Type.String({ description: "Subagent role to use" }),
      task: Type.String({ description: "Specific task for the subagent" }),
      context: Type.Optional(
        Type.String({
          description:
            "Extra context to give the subagent (selected code, prior results, file list, etc.). Delivered as a separate channel from the task. Omit if the task alone is enough.",
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Reference file paths for the subagent to read directly (e.g. ["src/auth.ts", "docs/api.md"]). Injected as @file attachments — content stays out of your context window. Prefer this over pasting file contents into context.',
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
      model: Type.Optional(
        Type.String({
          description:
            "Override the model for this call. Format: 'provider/model-id' (e.g. 'anthropic/claude-sonnet-4'). When set, bypasses the role's configured model — useful for one-off vision tasks or model-specific jobs without creating a permanent role.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const gate = concurrencyGate;
      const roleDef = availableRoles[params.role];
      if (!roleDef) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown subagent role: ${params.role}. Available: ${Object.keys(availableRoles).join(", ")}`,
            },
          ],
          details: undefined as any,
        };
      }

      // Guard against bounded subagent nesting. A configured depth of 0 is unlimited.
      if (config.maxDepth > 0 && CURRENT_DEPTH >= config.maxDepth) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot delegate: maximum nesting depth (${config.maxDepth}) reached (current depth ${CURRENT_DEPTH}). Return a result to the caller instead of delegating further.`,
            },
          ],
          details: undefined as any,
          isError: true,
        };
      }

      // Throttle state hoisted to the execute scope so the finally block can clear it.
      // (try-body `let` is invisible to catch/finally — JS gives each its own block scope.)
      let pendingPartial: Partial<SubagentResult> | undefined;
      let throttleHandle: ReturnType<typeof setTimeout> | undefined;

      // Flush a terminal onUpdate so the TUI's final render reflects the
      // real outcome (✓/✗/⏱/⏲), not a stale "running" ⏳ partial. Without it,
      // the last onUpdate the framework saw was an exitCode:-1 progress frame,
      // so the finished delegate block can keep showing the hourglass (residue).
      // Hoisted to execute scope (not try-body) so catch can flush on abort too.
      const emitFinal = (results: SubagentResult[], text: string) => {
        if (!onUpdate) return;
        if (throttleHandle !== undefined) {
          clearTimeout(throttleHandle);
          throttleHandle = undefined;
        }
        pendingPartial = undefined;
        onUpdate({
          content: [{ type: "text", text }],
          details: { mode: "single", results },
        });
      };
      // Emit a queued placeholder only when this call will actually wait.
      if (onUpdate && gate.isAtCapacity) {
        const queued: SubagentResult = {
          role: params.role,
          task: params.task,
          exitCode: -1,
          queued: true,
          messages: [],
          output: "",
          stderr: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
          activityLog: [],
          files: params.files,
          context: params.context,
        };
        onUpdate({
          content: [{ type: "text", text: `${params.role}: queued...` }],
          details: { mode: "single", results: [queued] },
        });
      }

      // Acquire a concurrency slot (abortable while queued)
      try {
        await gate.acquire(signal);
      } catch {
        return {
          content: [
            { type: "text", text: `Subagent (${params.role}) was cancelled while queued.` },
          ],
          details: { mode: "single", results: [] },
          isError: true,
        };
      }

      try {
        // Resolve model AFTER acquiring so the queued period stays zero-cost
        let rolesApi: ModelRolesAPI;
        try {
          rolesApi = getModelRolesAPI();
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "pi-model-roles is not initialized. Cannot resolve model for subagent.",
              },
            ],
            details: undefined as any,
          };
        }

        let modelRef: string;
        let thinking: ThinkingLevel | undefined;
        if (params.model) {
          modelRef = params.model;
        } else {
          const resolved = await rolesApi.resolveRoleAsync(roleDef.role);
          if (!resolved.model) {
            return {
              content: [
                {
                  type: "text",
                  text: `Role "${roleDef.role}" could not be resolved. Model not available.`,
                },
              ],
              details: undefined as any,
            };
          }
          modelRef = `${resolved.model.provider}/${resolved.model.id}`;
          thinking = resolved.config.thinking;
        }
        const startTime = Date.now();
        // Total active-time budget for this run (ms). The clock pauses while the
        // child delegates, so this caps *active* time, not wall time.
        const timeoutBudgetMs = effectiveTimeout(roleDef) * 1000;
        const maxTurns = roleDef.maxTurns ?? config.maxTurns;
        const maxCost = roleDef.maxCost ?? config.maxCost;

        // Throttled progress: coalesces bursty thinking/tool events so the TUI
        // repaints at most ~every PROGRESS_THROTTLE_MS, always keeping the latest state.
        const renderProgress = (partial: Partial<SubagentResult>) => {
          // Wall-clock elapsed (always ticking, even during delegate pauses).
          const realElapsed = Math.round((Date.now() - startTime) / 1000);
          const budgetSec = Math.round(timeoutBudgetMs / 1000);
          const graceMs =
            (partial.graceMs ?? 0) + (partial.pauseStart ? Date.now() - partial.pauseStart : 0);
          const graceSec = Math.round(graceMs / 1000);
          const timeText =
            budgetSec > 0
              ? graceSec > 0
                ? `${realElapsed}s/${budgetSec}s(+${graceSec}s)`
                : `${realElapsed}s/${budgetSec}s`
              : `${realElapsed}s`;
          const liveResult: SubagentResult = {
            role: params.role,
            task: params.task,
            exitCode: -1,
            messages: partial.messages ?? [],
            output: partial.output ?? "",
            stderr: "",
            usage: partial.usage ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
            model: partial.model,
            stopReason: partial.stopReason,
            activityLog: partial.activityLog ?? [],
            startTime,
            budgetMs: timeoutBudgetMs,
            graceMs: partial.graceMs,
            pauseStart: partial.pauseStart,
            files: params.files,
            context: params.context,
          };
          const statusText = `${params.role}  ${timeText}  ${liveResult.usage.turns} turn${liveResult.usage.turns !== 1 ? "s" : ""}`;
          onUpdate!({
            content: [{ type: "text", text: statusText }],
            details: { mode: "single", results: [liveResult] },
          });
        };
        const emitProgress = (partial: Partial<SubagentResult>) => {
          if (!onUpdate) return;
          pendingPartial = partial;
          if (throttleHandle !== undefined) return;
          throttleHandle = setTimeout(() => {
            throttleHandle = undefined;
            const p = pendingPartial;
            pendingPartial = undefined;
            if (p) renderProgress(p);
          }, PROGRESS_THROTTLE_MS);
        };

        // Emit running placeholder now that we hold a slot
        if (onUpdate) {
          const placeholder: SubagentResult = {
            role: params.role,
            task: params.task,
            exitCode: -1,
            messages: [],
            output: "",
            stderr: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
            activityLog: [],
            startTime,
            files: params.files,
            context: params.context,
          };
          onUpdate({
            content: [{ type: "text", text: `${params.role}: running...` }],
            details: { mode: "single", results: [placeholder] },
          });
        }

        let result = await spawnSubagent(modelRef, params.task, {
          cwd: params.cwd ?? ctx.cwd,
          thinking,
          tools: roleDef.tools,
          systemPrompt: roleDef.systemPrompt,
          context: params.context,
          contextFiles: params.files,
          subagentRoles: roleDef.subagentRoles,
          timeoutMs: timeoutBudgetMs,
          maxTurns,
          maxCost,
          depth: CURRENT_DEPTH + 1,
          signal,
          onProgress: emitProgress,
        });
        // Keep the stored/displayed task as the user's original (not context-expanded)
        result.task = params.task;

        // Retry with fallback role on provider errors (quota, auth, timeout, etc.)
        if (
          (result.exitCode !== 0 || result.errorMessage) &&
          roleDef.fallbackRole &&
          isProviderError(result)
        ) {
          const fallback = await rolesApi.resolveRoleAsync(roleDef.fallbackRole);
          if (fallback.model) {
            const fbRef = `${fallback.model.provider}/${fallback.model.id}`;
            result = await spawnSubagent(fbRef, params.task, {
              cwd: params.cwd ?? ctx.cwd,
              thinking: fallback.config.thinking,
              tools: roleDef.tools,
              systemPrompt: roleDef.systemPrompt,
              context: params.context,
              contextFiles: params.files,
              subagentRoles: roleDef.subagentRoles,
              timeoutMs: timeoutBudgetMs,
              maxTurns,
              maxCost,
              depth: CURRENT_DEPTH + 1,
              signal,
              onProgress: emitProgress,
            });
            result.task = params.task;
          }
        }

        // Stamp terminal fields once, after any fallback retry: elapsedMs covers
        // the whole delegate span (incl. retry); files/context mirror params for the TUI.
        result.files = params.files;
        result.context = params.context;
        result.elapsedMs = Date.now() - startTime;

        // Compress/truncate oversized output before it reaches the main model or TUI.
        // Keep the raw original for the history file (audit), feed the prepared text to LLM + expanded view.
        const rawOutput = result.output;
        if (result.output.length > MAX_OUTPUT_CHARS) {
          const { text, method } = await compressOutput(
            rolesApi,
            result.output,
            params.task,
            config.summary,
          );
          result.output = text;
          result.outputMethod = method;
        } else {
          result.outputMethod = "raw";
        }

        // Generate summary for TUI display
        if (config.summary.enabled && result.output.trim()) {
          result.summary = await generateSummary(rolesApi, result.output, config.summary);
        }

        // Persist audit record (best-effort; covers both success and failure).
        // History keeps the raw original output even when LLM/TUI saw a compressed/truncated version.
        if (config.history.enabled) {
          let sessionId: string | undefined;
          try {
            sessionId = ctx.sessionManager?.getSessionId();
          } catch {
            /* ignore */
          }
          persistSubagentHistory(
            sessionId,
            _toolCallId,
            params.role,
            params.task,
            result,
            rawOutput,
          );
        }

        if (result.exitCode !== 0 || result.errorMessage) {
          const failedText = `Subagent (${params.role}) failed: ${result.errorMessage || result.stderr || "unknown error"}\n\nPartial output:\n${result.output}`;
          emitFinal([result], failedText);
          return {
            content: [{ type: "text", text: failedText }],
            details: { mode: "single", results: [result] },
            isError: true,
          };
        }

        // Build concise output for the main model with usage info
        const usageParts: string[] = [];
        if (result.usage.turns)
          usageParts.push(`${result.usage.turns} turn${result.usage.turns > 1 ? "s" : ""}`);
        if (result.usage.input) usageParts.push(`\u2191${formatTokens(result.usage.input)}`);
        if (result.usage.output) usageParts.push(`\u2193${formatTokens(result.usage.output)}`);
        if (result.usage.cost) usageParts.push(`$${result.usage.cost.toFixed(4)}`);
        if (result.model) usageParts.push(result.model);
        const usageLine = usageParts.length > 0 ? `\n\n--- ${usageParts.join(" ")} ---` : "";

        const finalText = result.output + usageLine;
        emitFinal([result], finalText);
        return {
          content: [{ type: "text", text: finalText }],
          details: { mode: "single", results: [result] },
        };
      } catch (err: any) {
        const errorText = `Subagent (${params.role}) error: ${err.message || err}`;
        emitFinal([], errorText);
        return {
          content: [{ type: "text", text: errorText }],
          details: { mode: "single", results: [] },
          isError: true,
        };
      } finally {
        // Cancel any trailing throttled onUpdate regardless of how we exited
        // (success / fallback / budget / error). A stale "still running" progress
        // event fired after the tool returns corrupts framework tool state and
        // crashes the TUI — notably in delegate chains where a subagent itself
        // delegates (worker → explorer): the inner crash surfaces as TUI escapes.
        if (throttleHandle !== undefined) clearTimeout(throttleHandle);
        pendingPartial = undefined;
        gate.release();
      }
    },

    // TUI rendering lives in ./render.ts — call row and result view.
    renderCall: renderDelegateCall,
    renderResult: renderDelegateResult,
  });
  pi.registerCommand("subagent:doctor", {
    description: "Diagnose pi-subagent configuration and dependencies",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      let allOk = true;

      // 1. pi executable
      const inv = getPiInvocation(["--version"]);
      lines.push(`[\u2713] pi invocation: ${inv.command} ${inv.args.slice(0, 1).join(" ")}`);

      // 2. pi-model-roles
      try {
        const api = getModelRolesAPI();
        lines.push("[\u2713] pi-model-roles: loaded");

        // 3. config
        try {
          const cfg = loadSubagentConfig(ctx.cwd);
          lines.push(
            `[\u2713] config: concurrency=${cfg.maxConcurrency || "∞"} depth=${cfg.maxDepth || "∞"} turns=${cfg.maxTurns || "∞"} cost=$${cfg.maxCost || "∞"} summary=${cfg.summary.enabled ? cfg.summary.role : "off"} history=${cfg.history.enabled}`,
          );
        } catch {
          lines.push("[\u2717] config: failed to load");
          allOk = false;
        }

        // 4. roles (+ fallbackRole + subagentRoles references)
        for (const [name, role] of Object.entries(availableRoles)) {
          try {
            const resolved = await api.resolveRoleAsync(role.role);
            if (resolved.model) {
              lines.push(
                `[\u2713] role ${name}: \u2192 ${resolved.model.provider}/${resolved.model.id}`,
              );
            } else {
              lines.push(`[\u2717] role ${name}: model not resolved (role config: ${role.role})`);
              allOk = false;
            }
          } catch {
            lines.push(`[\u2717] role ${name}: resolution failed`);
            allOk = false;
          }

          // fallbackRole must also resolve to a usable model
          if (role.fallbackRole) {
            try {
              const fb = await api.resolveRoleAsync(role.fallbackRole);
              if (!fb.model) {
                lines.push(
                  `[\u2717] role ${name}: fallbackRole "${role.fallbackRole}" not resolved`,
                );
                allOk = false;
              }
            } catch {
              lines.push(
                `[\u2717] role ${name}: fallbackRole "${role.fallbackRole}" resolution failed`,
              );
              allOk = false;
            }
          }

          // subagentRoles must reference known roles
          if (role.subagentRoles) {
            for (const ref of role.subagentRoles) {
              if (!(ref in availableRoles)) {
                lines.push(`[\u2717] role ${name}: subagentRoles references unknown role "${ref}"`);
                allOk = false;
              }
            }
          }
        }
      } catch {
        lines.push("[\u2717] pi-model-roles: not initialized");
        allOk = false;
      }

      // 5. runtime context
      const allowed = process.env.PI_SUBAGENT_ALLOWED;
      if (allowed) lines.push(`[i] PI_SUBAGENT_ALLOWED: ${allowed}`);
      lines.push(
        `[i] depth: ${CURRENT_DEPTH}/${config.maxDepth || "∞"}  concurrency: ${config.maxConcurrency || "∞"}`,
      );

      const summary = allOk ? "All checks passed" : "Some checks failed";
      ctx.ui.notify(`${summary}\n\n${lines.join("\n")}`, "info");
    },
  });
}
