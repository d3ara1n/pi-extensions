/**
 * Spawn a pi child process and collect structured output with real-time progress.
 *
 * Uses pi's --mode rpc: the child streams agent events on stdout and accepts
 * JSON commands on stdin (initial prompt, mid-run steering). Fires onProgress
 * on each event for streaming TUI updates; the message stream is parsed for
 * usage/output extraction, with thinking blocks, tool calls, and streamed
 * assistant text mirrored into the activity log for rendering.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentControl, SubagentMessage, SubagentResult } from "./types.ts";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

// ── Parent-exit safety net ─────────────────────────────────────
// process.on("exit") fires synchronously on every terminal path that goes
// through process.exit — normal quit, signal-triggered graceful shutdown,
// emergency terminal exit, uncaught crash. SIGTERM the live children so each
// pi child runs its own cleanup (killing ITS tracked grandchildren) instead
// of burning tokens as an orphan. This covers the paths where the graceful
// session_shutdown reaping never fires; a SIGKILL'd parent is beyond help.
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;
function reapChildrenOnExit(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const child of liveChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
  });
}

function isRunnableScript(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    return /\.(?:mjs|cjs|js)$/i.test(filePath);
  } catch {
    return false;
  }
}

function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
  let dir = path.dirname(entryPoint);
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: unknown };
        if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
      } catch {
        /* ignore */
      }
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function resolveWindowsPiCliScript(
  args: string[],
): { command: string; args: string[] } | undefined {
  // Strategy 1: Use process.argv[1] if it's a runnable script
  // (works when pi is run via `bun pi` or `bunx pi` — argv[1] is the real CLI path)
  const argv1 = process.argv[1];
  if (argv1) {
    const argvPath = path.isAbsolute(argv1) ? argv1 : path.resolve(argv1);
    if (isRunnableScript(argvPath)) {
      return { command: process.execPath, args: [argvPath, ...args] };
    }
  }

  // Strategy 2: Resolve pi-coding-agent package via import.meta.resolve,
  // then read the bin field from its package.json
  try {
    const resolved = fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE));
    const root = findPiPackageRootFromEntry(resolved);
    if (root) {
      const pkgPath = path.join(root, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        bin?: string | Record<string, string>;
      };
      const binField = pkg.bin;
      const binPath =
        typeof binField === "string"
          ? binField
          : (binField?.pi ?? Object.values(binField ?? {})[0]);
      if (binPath) {
        const candidate = path.resolve(root, binPath);
        if (isRunnableScript(candidate)) {
          return { command: process.execPath, args: [candidate, ...args] };
        }
      }
    }
  } catch {
    /* fall through */
  }

  return undefined;
}

/**
 * Determine how to invoke pi.
 *
 * On Windows, attempts to find the pi CLI script via:
 *   1. process.argv[1] (when run via `bun pi` or `bunx pi`)
 *   2. import.meta.resolve of @earendil-works/pi-coding-agent → bin field
 * If found, spawns process.execPath (bun) with the script path.
 * Falls back to `pi` from PATH if neither works.
 *
 * On non-Windows, always uses the `pi` CLI command from PATH.
 *
 * This avoids the standalone compiled pi.exe's process.execPath
 * (virtual Bun path like B:/~BUN/root/pi.exe) ever being passed
 * to the child process, while still working when `pi` is not in PATH.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const winResult = resolveWindowsPiCliScript(args);
    if (winResult) return winResult;
  }
  return { command: "pi", args };
}

/**
 * Build the pi CLI args for one child run (RPC mode).
 *
 * Tool policy mirrors pi's CLI flags in three mutually exclusive states
 * (tools + excludeTools together is rejected at role resolution):
 *   - `tools` set      → exact allowlist (`--tools`; empty = `--no-tools`, literally zero tools)
 *   - `excludeTools` set → denylist (`--exclude-tools`; empty ≡ absent — nothing excluded)
 *   - neither          → all tools (no flag)
 *
 * @internal — exported for testing.
 */
export function buildChildArgs(
  modelRef: string,
  options: {
    thinking?: string;
    tools?: string[];
    excludeTools?: string[];
    systemPrompt?: string;
    inheritConversation?: boolean;
  },
  tmpDir: string,
): string[] {
  const args: string[] = ["--mode", "rpc", "--no-session", "--model", modelRef];

  if (options.thinking) {
    args.push("--thinking", options.thinking);
  }

  if (options.tools) {
    if (options.tools.length > 0) {
      args.push("--tools", options.tools.join(","));
    } else {
      args.push("--no-tools");
    }
  } else if (options.excludeTools && options.excludeTools.length > 0) {
    args.push("--exclude-tools", options.excludeTools.join(","));
  }

  // System prompt channel: inline text via --append-system-prompt. pi's
  // resolvePromptInput treats an existing path as a file to read and any
  // non-path string as literal text, so structured blocks go directly — no
  // temp file, zero disk I/O.
  if (options.systemPrompt?.trim()) {
    args.push(
      "--append-system-prompt",
      `<subagent_role>\n${options.systemPrompt.trim()}\n</subagent_role>`,
    );
  }
  args.push(
    "--append-system-prompt",
    `<subagent_env>\nPI_SUBAGENT_TMPDIR=${tmpDir}\nAvailable as $PI_SUBAGENT_TMPDIR in bash. Use for git clone and scratch files.\n</subagent_env>`,
  );
  // Shared behavioral policy for EVERY subagent run — built-in roles and
  // agentOverrides customs alike. Role prompts (roles.ts) shape WHAT a role
  // does; this shapes HOW any subagent behaves when the task exceeds its
  // actual capabilities: report the gap and stop instead of improvising
  // workarounds until timeout.
  const conversationPolicy = options.inheritConversation
    ? [
        "- You have an <inherited_conversation> block from the parent session.",
        "  It is text-only background and may be compacted or truncated. If needed",
        "  material is absent, report it as Missing — do not guess it.",
      ]
    : [
        "- The task may reference material as 'discussed above' or 'the requirements'",
        "  — you have NO prior conversation; only this prompt exists. If referenced",
        "  material is not in this prompt, report it as Missing — do not guess it.",
      ];
  args.push(
    "--append-system-prompt",
    [
      "<subagent_policy>",
      "Before attempting the task, check it against your actual capabilities in this",
      "session — the tool list here is definitive.",
      "- If the task needs a capability you do not have (web access, bash, file",
      "  writes, ...) or material that is absent from local files and the provided",
      "  prompt channels, it is out of scope for you. Do NOT improvise workarounds.",
      ...conversationPolicy,
      '- "Cannot complete" means a capability or material gap — not "difficult" or',
      '  "uncertain". If it is merely hard, keep working within your tools.',
      "- When you hit a genuine gap, stop early and return:",
      "  ## Cannot complete",
      "  - Missing: the capability or material that is absent",
      "  - Needed: what would complete the task",
      "  - Found: partial findings so far (optional)",
      "",
      'An early "cannot complete" report is a successful outcome; grinding on',
      "impossible workarounds until timeout is the failure.",
      "</subagent_policy>",
    ].join("\n"),
  );

  return args;
}

/**
 * Compose the initial RPC prompt message: reference files as <file> blocks,
 * optional inherited conversation, then context and task as structured tags —
 * the same shape the child saw in json mode (@file arguments wrapped by pi's
 * processFileArguments, followed by the inline message body).
 *
 * @internal — exported for testing.
 */
export async function composeInitialMessage(
  files: string[] | undefined,
  inheritedConversation: string | undefined,
  context: string | undefined,
  task: string,
): Promise<string> {
  const parts: string[] = [];
  if (files) {
    for (const f of files) {
      let content: string;
      try {
        content = await fs.promises.readFile(f, "utf-8");
      } catch {
        content = `(failed to read file: ${f})`;
      }
      parts.push(`<file name="${f}">\n${content}\n</file>`);
    }
  }
  if (inheritedConversation !== undefined) {
    parts.push(
      [
        "<inherited_conversation>",
        "Text-only background from the parent conversation; it may be compacted or truncated. The separate task block remains authoritative.",
        "",
        inheritedConversation,
        "</inherited_conversation>",
      ].join("\n"),
    );
  }
  if (context?.trim()) parts.push(`<context>\n${context}\n</context>`);
  if (task.trim()) parts.push(`<task>\n${task}\n</task>`);
  return parts.join("\n\n");
}

/**
 * Spawn a pi child process with the given model and configuration.
 * Fires onProgress on each JSON event for streaming TUI updates.
 *
 * @param modelRef - Model identifier like "deepseek/deepseek-v4-flash"
 * @param task - The task prompt
 * @param options - Spawn options
 * @returns SubagentResult with collected messages and usage stats
 */
export async function spawnSubagent(
  modelRef: string,
  task: string,
  options: {
    cwd?: string;
    /** Thinking level passed to the child pi process when the role defines one. */
    thinking?: string;
    /** Extra tools withheld from the child (denylist); ignored when `tools` is set. */
    excludeTools?: string[];
    tools?: string[];
    systemPrompt?: string;
    /** Extra context delivered as a separate channel from the task. */
    context?: string;
    /** Enables the inherited-conversation policy variant. */
    inheritConversation?: boolean;
    /** Immutable serialized parent-conversation body injected independently from context/task. */
    inheritedConversation?: string;
    /** Reference files injected as <file> blocks in the initial prompt (child reads them directly). */
    contextFiles?: string[];
    subagentRoles?: string[];
    timeoutMs?: number;
    depth?: number;
    /** Kill after this many assistant turns; 0/undefined = unlimited (negatives normalize to 0). */
    maxTurns?: number;
    /** Kill after this cumulative cost in USD; 0/undefined = unlimited (negatives normalize to 0). */
    maxCost?: number;
    signal?: AbortSignal;
    onProgress?: (update: Partial<SubagentResult>) => void;
    /** Called once the child process exists — exposes the stdin steering channel. */
    onControl?: (control: SubagentControl) => void;
  },
): Promise<SubagentResult> {
  const result: SubagentResult = {
    role: "",
    task,
    exitCode: 0,
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
  };

  // ── Active-time timeout accounting ──
  // The parent's timeout clock PAUSES while the child is inside a nested
  // `subagent_delegate` tool call, so each nested subagent gets its own full timeout
  // budget instead of racing the parent's wall clock. `graceMs` is the
  // accumulated paused time — display only; the verdict is always
  // "active elapsed >= budget" (pausing grants no extra active time).
  const budgetMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs ?? 0) : 0;
  let activeElapsedAccum = 0; // settled active ms (excludes suspended spans)
  let segmentStart = 0; // wall-clock start of the current active segment; 0 = no active segment
  let isSuspended = false; // true while a child `subagent_delegate` call is in flight
  let pauseStart = 0; // wall-clock mark when the current suspend began
  let graceMs = 0; // accumulated suspended ms (display only)
  /** toolCallIds of in-flight `subagent_delegate` calls — end events lack toolName, so we pair by id. */
  const delegateCallIds = new Set<string>();

  let tmpDir: string | null = null;

  try {
    // Scratch dir handed to the child as PI_SUBAGENT_TMPDIR for its bash work
    // (e.g. git clone). The initial prompt goes over stdin, so there is no
    // argv length limit and no spill-to-tempfile channel anymore.
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));

    const args = buildChildArgs(modelRef, options, tmpDir);

    // ── Initial prompt channel: one RPC prompt command over stdin ──
    // RPC mode rejects @file argv, so reference files are inlined here as
    // <file name="..."> blocks — the same wrap pi applies to @file arguments
    // (processFileArguments). Content still never enters the parent model's
    // context; this process reads the bytes off disk and pipes them straight
    // to the child.
    const initialMessage = await composeInitialMessage(
      options.contextFiles,
      options.inheritedConversation,
      options.context,
      task,
    );

    // Spawn process
    const invocation = getPiInvocation(args);
    let wasAborted = false;
    let budgetExceeded = false;
    let wasTimeout = false;
    let buffer = "";

    /** Serialize one JSONL command frame for the child's stdin. */
    const sendCommand = (command: Record<string, unknown>): void => {
      try {
        proc?.stdin?.write(`${JSON.stringify(command)}\n`);
      } catch {
        /* child gone — nothing to steer */
      }
    };

    const emitProgress = () => {
      options.onProgress?.({
        output: result.output,
        usage: { ...result.usage },
        model: result.model,
        stopReason: result.stopReason,
        activityLog: result.activityLog.map((a) => ({ ...a })),
        graceMs,
        pauseStart: isSuspended ? pauseStart : 0,
      });
    };

    let thinkingCounter = 0;
    let textCounter = 0;
    // O(1) lookup from toolCallId → activityLog index.
    const toolCallIndex = new Map<string, number>();

    // Streamed text deltas bypass the per-event emitProgress (copying the whole
    // activityLog per token is quadratic); a time gate keeps live frames fresh
    // enough for the :view overlay without flooding the frame pipeline.
    let lastDeltaEmit = 0;
    const DELTA_EMIT_INTERVAL_MS = 200;

    let steerCounter = 0;

    // Normalized turn/cost budgets (0 = unlimited). Role overrides can arrive
    // raw from settings.json, so negatives/non-finites normalize here.
    const maxTurns = Number.isFinite(options.maxTurns) ? Math.max(0, options.maxTurns ?? 0) : 0;
    const maxCost = Number.isFinite(options.maxCost) ? Math.max(0, options.maxCost ?? 0) : 0;

    // Kill the child when the configured turn/cost budget is exceeded.
    // Called after each assistant message_end (usage already accumulated).
    const checkBudget = () => {
      if (budgetExceeded || wasTimeout) return;
      if (
        (maxTurns > 0 && result.usage.turns >= maxTurns) ||
        (maxCost > 0 && result.usage.cost >= maxCost)
      ) {
        budgetExceeded = true;
        killProc("budget");
      }
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      // RPC command acknowledgements ("response" lines) carry no agent state.
      if (event.type === "response") return;

      // The child is a headless worker — nobody can answer its dialogs.
      // RPC-mode ctx.ui.select/confirm/input emit extension_ui_request and
      // park the child's extension on a promise that has NO default timeout;
      // without a response the child hangs until the run timeout kills it.
      // Answer immediately with cancelled:true — the standard "user declined"
      // semantics (undefined/false) extensions already handle. Fire-and-forget
      // methods (notify/setStatus/setWidget/setTitle) need no answer.
      if (event.type === "extension_ui_request" && event.id) {
        if (event.method === "select" || event.method === "confirm" || event.method === "input") {
          sendCommand({ type: "extension_ui_response", id: event.id, cancelled: true });
        }
        return;
      }

      // RPC mode is a resident server. agent_end only marks one low-level run
      // and may be followed by an automatic retry, compaction, or queued
      // continuation. agent_settled is the authoritative terminal event. We run
      // one prompt per child, so ending stdin there triggers graceful shutdown
      // (onInputEnd → runtime dispose → exit).
      if (event.type === "agent_settled") {
        try {
          proc?.stdin?.end();
        } catch {
          /* already gone */
        }
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as SubagentMessage;

        if (msg.role === "assistant") {
          result.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            result.usage.input += usage.input || 0;
            result.usage.output += usage.output || 0;
            result.usage.cacheRead += usage.cacheRead || 0;
            result.usage.cacheWrite += usage.cacheWrite || 0;
            result.usage.cost += usage.cost?.total || 0;
            // Peak context size, not last-turn size (accumulating is meaningless; max tells how close to the limit)
            result.usage.contextTokens = Math.max(
              result.usage.contextTokens,
              usage.totalTokens || 0,
            );
          }
          // The child's AssistantMessage carries the bare model id with the
          // provider in a separate field — compose the full `provider/model-id`
          // ref so usage displays match the delegate-facing modelRef format.
          if (!result.model && msg.model) {
            result.model = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
          }
          // message_end is authoritative for the latest assistant attempt. A
          // successful native retry must clear the transient error left by the
          // failed attempt instead of triggering a redundant whole-run fallback.
          result.stopReason = msg.stopReason;
          result.errorMessage = msg.errorMessage;

          // Track last assistant text
          for (const part of msg.content) {
            if (part.type === "text" && part.text) {
              result.output = part.text;
            }
          }

          checkBudget();
        }

        freezeRunningTextEntries();
        emitProgress();
      }

      // Activity log: track thinking blocks and tool calls in arrival order.
      // Both update in place so the TUI reflects real-time state.
      if (event.type === "tool_execution_start" && event.toolCallId) {
        toolCallIndex.set(event.toolCallId, result.activityLog.length);
        result.activityLog.push({
          kind: "toolCall",
          id: event.toolCallId,
          status: "running",
          toolName: event.toolName,
          args: event.args ?? {},
        });
        // Pause the parent timeout clock while the child delegates — nested
        // subagents get their own full budget instead of racing this clock.
        // Ref-counted: concurrent subagent_delegate calls pause once and resume
        // only when the last in-flight one returns.
        if (event.toolName === "subagent_delegate") {
          const first = delegateCallIds.size === 0;
          delegateCallIds.add(event.toolCallId);
          if (first) suspendTimeout();
        }
        emitProgress();
      } else if (event.type === "tool_execution_end" && event.toolCallId) {
        const idx = toolCallIndex.get(event.toolCallId);
        if (idx !== undefined) result.activityLog[idx].status = event.isError ? "failed" : "done";
        // Resume the parent timeout clock only when the last in-flight delegate returns.
        if (delegateCallIds.delete(event.toolCallId) && delegateCallIds.size === 0) {
          resumeTimeout();
        }
        emitProgress();
      }

      // Thinking-block lifecycle: pi wraps thinking_start/end inside
      // message_update.assistantMessageEvent. These arrive BEFORE message_end,
      // so we can't rely on messages[] to show real-time thinking state —
      // register them in the activity log directly.
      const aev = event.assistantMessageEvent;
      if (event.type === "message_update" && aev) {
        if (aev.type === "thinking_start") {
          result.activityLog.push({
            kind: "thinking",
            id: `thinking-${thinkingCounter++}`,
            status: "running",
          });
          emitProgress();
        } else if (aev.type === "thinking_end") {
          // Mark the most recent still-running thinking block as done.
          for (let i = result.activityLog.length - 1; i >= 0; i--) {
            if (
              result.activityLog[i].kind === "thinking" &&
              result.activityLog[i].status === "running"
            ) {
              result.activityLog[i].status = "done";
              break;
            }
          }
          emitProgress();
        } else if (aev.type === "text_start") {
          result.activityLog.push({
            kind: "text",
            id: `text-${textCounter++}`,
            status: "running",
            text: "",
          });
          emitProgress();
        } else if (aev.type === "text_delta" && aev.delta) {
          // Append to the still-running text entry; skip the frame copy per token.
          for (let i = result.activityLog.length - 1; i >= 0; i--) {
            const entry = result.activityLog[i];
            if (entry.kind === "text" && entry.status === "running") {
              entry.text = (entry.text ?? "") + aev.delta;
              break;
            }
            if (entry.kind === "text") break;
          }
          const now = Date.now();
          if (now - lastDeltaEmit >= DELTA_EMIT_INTERVAL_MS) {
            lastDeltaEmit = now;
            emitProgress();
          }
        }
      }
    };

    /** Freeze every still-running text entry — called on message_end (turn boundary). */
    const freezeRunningTextEntries = () => {
      for (const entry of result.activityLog) {
        if (entry.kind === "text" && entry.status === "running") {
          entry.status = "done";
        }
      }
    };

    // Child env: the role allowlist for nested delegation, the shared scratch
    // tmpdir for subagent bash work (e.g. git clone), and the nesting depth.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (options.subagentRoles && options.subagentRoles.length > 0) {
      childEnv.PI_SUBAGENT_ALLOWED = options.subagentRoles.join(",");
    }
    childEnv.PI_SUBAGENT_TMPDIR = tmpDir;
    childEnv.PI_SUBAGENT_DEPTH = String(options.depth ?? 0);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let proc: ChildProcess | undefined;
    let processExited = false;
    let terminationRequested = false;

    const clearEscalationTimer = () => {
      if (!escalationTimer) return;
      clearTimeout(escalationTimer);
      escalationTimer = undefined;
    };

    // Shared kill helper used by abort, budget, and timeout paths.
    // A single termination request sends SIGTERM once. SIGKILL is sent only if
    // the process has not emitted exit/close after the grace period.
    const killProc = (reason: "abort" | "budget" | "timeout") => {
      if (terminationRequested || processExited) return;
      terminationRequested = true;
      if (reason === "abort") wasAborted = true;
      else if (reason === "budget") {
        result.stopReason = "budget_exceeded";
        // Human-readable so the caller/TUI never falls back to raw stderr noise.
        const why =
          maxTurns > 0 && result.usage.turns >= maxTurns
            ? `${result.usage.turns} turns`
            : `$${result.usage.cost.toFixed(4)}`;
        result.errorMessage = `Budget exceeded (${why}; partial output returned)`;
      } else {
        result.stopReason = "timeout";
        wasTimeout = true;
        // Human-readable message so the caller/TUI never falls back to the
        // raw stderr (which is full of TUI teardown escape sequences).
        const secs = Math.round(budgetMs / 1000);
        result.errorMessage = `Timed out after ${secs}s (completed ${result.usage.turns} turn${result.usage.turns === 1 ? "" : "s"})`;
      }

      try {
        if (!proc || !proc.kill("SIGTERM")) return;
      } catch {
        return;
      }
      escalationTimer = setTimeout(() => {
        if (processExited) return;
        try {
          proc?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5000);
    };

    /** Pause the active-time clock (called on child `subagent_delegate` start). */
    const suspendTimeout = () => {
      if (isSuspended) return;
      if (segmentStart > 0) {
        activeElapsedAccum += Date.now() - segmentStart;
        segmentStart = 0;
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      pauseStart = Date.now();
      isSuspended = true;
    };
    /** Resume the active-time clock (called on child `subagent_delegate` end). */
    const resumeTimeout = () => {
      if (!isSuspended) return;
      graceMs += Date.now() - pauseStart;
      isSuspended = false;
      segmentStart = Date.now();
      if (budgetMs > 0) {
        const remaining = budgetMs - activeElapsedAccum;
        if (remaining > 0) {
          timeoutHandle = setTimeout(() => killProc("timeout"), remaining);
        } else {
          killProc("timeout"); // active budget already exhausted while paused
        }
      }
    };

    const exitCode = await new Promise<number>((resolve) => {
      // Register abort BEFORE spawning to close the (tiny) registration window
      let onAbort: (() => void) | undefined;
      if (options.signal) {
        if (options.signal.aborted) {
          wasAborted = true;
          resolve(0);
          return;
        }
        onAbort = () => killProc("abort");
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      const p = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: childEnv,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc = p;
      liveChildren.add(p);
      reapChildrenOnExit();

      // Expose the stdin control channel (steering) to the owner. Writes are
      // fire-and-forget: once the child is gone the try/catch in sendCommand
      // swallows EPIPE.
      options.onControl?.({
        steer(message: string) {
          if (processExited || terminationRequested) return;
          sendCommand({ type: "steer", message });
          // Mirror the steer into the activity feed so the :view overlay shows
          // what was injected and when.
          result.activityLog.push({
            kind: "steer",
            id: `steer-${steerCounter++}`,
            status: "done",
            text: message,
          });
          emitProgress();
        },
      });

      // Kick off the run: RPC mode starts idle and waits for a prompt command.
      sendCommand({ id: "init", type: "prompt", message: initialMessage });

      p.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      p.stderr.on("data", (data: Buffer) => {
        result.stderr += data.toString();
      });

      p.on("exit", () => {
        processExited = true;
        liveChildren.delete(p);
        clearEscalationTimer();
      });

      p.on("close", (code, signal) => {
        processExited = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        clearEscalationTimer();
        if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
        if (buffer.trim()) processLine(buffer);

        // External signal death (OOM killer, segfault, kill -9 from elsewhere)
        // that we didn't trigger. Distinguish from our own budget/timeout/abort kills
        // which set the flags before we send the signal.
        const externalKill = signal !== null && !budgetExceeded && !wasTimeout && !wasAborted;
        if (externalKill) {
          result.errorMessage = result.errorMessage || `Subagent killed by signal ${signal}`;
          result.stopReason = "error";
        }

        // Budget stops are intentional (finished); timeouts and external kills
        // are failures (non-zero); otherwise use the real exit code.
        resolve(budgetExceeded ? 0 : wasTimeout || externalKill ? (code ?? 128) : (code ?? 0));
      });

      p.on("error", (err) => {
        processExited = true;
        liveChildren.delete(p);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        clearEscalationTimer();
        if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
        // Surface the real cause (e.g. ENOENT when pi is not in PATH) instead of "unknown error".
        result.errorMessage = err?.message || String(err);
        resolve(1);
      });

      // Start the active-time clock. segmentStart marks the first active span;
      // it pauses/resumes around child `subagent_delegate` calls (see suspend/resumeTimeout).
      // No wall-clock fallback needed: each nested subagent has its own timeout,
      // so a stuck inner run is killed by its own clock and this layer resumes.
      segmentStart = Date.now();
      if (budgetMs > 0) {
        timeoutHandle = setTimeout(() => killProc("timeout"), budgetMs);
      }
    });

    result.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    // Large outputs stay raw here — compression/summary run in the engine (run.ts).
  } finally {
    // Cleanup temp directory and all contents
    if (tmpDir)
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
  }

  return result;
}
