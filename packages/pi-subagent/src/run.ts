/**
 * The delegation run engine — one async pipeline per delegate call, shared by
 * the foreground (blocking) and background tool paths. Foreground delegation
 * is background delegation that the tool call blocks on.
 *
 * startSubagentRun() returns a live RunHandle immediately: a small state
 * machine exposing the latest TUI-ready snapshot frame, a promise that always
 * resolves with the terminal result (never rejects — pipeline throws are
 * exposed via `thrown`), and a subscriber list the `wait` tool uses to mirror
 * live progress into its own tool row.
 *
 * Every run owns an AbortController. The foreground tool signal chains into
 * it; runs started without a caller signal (background) are still abortable
 * via handle.abort() — session_shutdown reaps every live run that way, so no
 * child process outlives the parent.
 *
 * All post-processing (fallback retry, output compression, summary
 * generation, history persistence) runs inside the pipeline, so background
 * runs finish exactly like foreground ones.
 */

import type { ModelRolesAPI, ThinkingLevel } from "@d3ara1n/pi-model-roles";
import type {
  FallbackFrom,
  RunState,
  SubagentConfig,
  SubagentControl,
  SubagentResult,
  SubagentRole,
} from "./types.ts";
import { spawnSubagent } from "./spawn.ts";
import {
  MAX_OUTPUT_CHARS,
  AsyncSemaphore,
  buildFallbackFrom,
  effectiveTimeout,
  emptyUsage,
  isFailedResult,
  isProviderError,
  truncateOutput,
} from "./utils.ts";
import { compressOutput, generateSummary } from "./output.ts";
import { persistSubagentHistory } from "./history.ts";

export interface RunHandle {
  /** Registry id (sub-N). */
  readonly id: string;
  readonly role: string;
  readonly task: string;
  readonly context?: string;
  readonly files?: string[];
  readonly inheritConversation?: boolean;
  readonly inheritedConversationChars?: number;
  readonly inheritedConversationTruncated?: boolean;
  /** Lifecycle state, kept in sync with the latest snapshot frame. */
  readonly state: RunState;
  /** Latest frame: queued placeholder, live progress, or terminal result. */
  readonly snapshot: SubagentResult;
  /** Terminal result; undefined while queued/running. */
  readonly result: SubagentResult | undefined;
  /** Set when the pipeline threw (abort, spawn crash). The terminal result still carries the partial frame — callers report it as an ordinary failed result; wait/check only see state "failed". */
  readonly thrown: Error | undefined;
  /** Successfully persisted terminal record; absent when history is disabled or writing failed. */
  readonly historyFile?: string;
  /** Resolves with the terminal result once the run finishes (always succeeds). */
  readonly promise: Promise<SubagentResult>;
  /** Abort the run — no-op after settle. Tool-cancellation and session-shutdown reaping both funnel here. */
  abort(reason?: string): void;
  /** Queue a steering message into the running child (RPC stdin). No-op when queued/settled. */
  steer(message: string): void;
  /** Get notified on every frame change. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
}

export interface StartRunOptions {
  id: string;
  /** delegate toolCallId — names the history record. */
  toolCallId: string;
  /** Role name key (params.role). */
  role: string;
  roleDef: SubagentRole;
  task: string;
  context?: string;
  files?: string[];
  /** Opt in to a text-only snapshot of the parent's active conversation. */
  inheritConversation?: boolean;
  /** Immutable serialized parent-conversation body; never persisted to history. */
  inheritedConversation?: string;
  /** Whether maxChars shortened the serialized parent conversation. */
  inheritedConversationTruncated?: boolean;
  cwd: string;
  /** Nesting depth for the child (CURRENT_DEPTH + 1). */
  depth: number;
  /** Foreground callers chain the tool's AbortSignal in; background runs pass none and are aborted via handle.abort() instead. */
  signal?: AbortSignal;
  /** Per-call model override ('provider/model-id'), bypassing the role's configured model. */
  modelOverride?: string;
  config: SubagentConfig;
  gate: AsyncSemaphore;
  /** May throw when pi-model-roles is not initialized — becomes a failed run. */
  getRolesApi: () => ModelRolesAPI;
  /** Captured at run creation so session replacement cannot redirect the record. */
  getSessionId?: () => string | undefined;
  background?: boolean;
  onHistoryError?: (message: string) => void;
  /** @internal — injectable spawn for tests. */
  spawnImpl?: typeof spawnSubagent;
  /** @internal — injectable history persistence for tests. */
  persistImpl?: (...args: Parameters<typeof persistSubagentHistory>) => string | void;
}

/** Race setup/post-processing work that may not support cancellation itself. */
function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Subagent was aborted"));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }).then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export function startSubagentRun(opts: StartRunOptions): RunHandle {
  const spawn = opts.spawnImpl ?? spawnSubagent;
  let sessionId: string | undefined;
  try { sessionId = opts.getSessionId?.(); } catch { /* unavailable in ephemeral hosts */ }
  let historyFile: string | undefined;
  const listeners = new Set<() => void>();
  const inheritanceMetadata = opts.inheritConversation
    ? {
        inheritConversation: true as const,
        inheritedConversationChars: opts.inheritedConversation?.length ?? 0,
        inheritedConversationTruncated: opts.inheritedConversationTruncated ?? false,
      }
    : {};

  const inputFrame = (exitCode: number, queued: boolean): SubagentResult => ({
    role: opts.role,
    task: opts.task,
    exitCode,
    queued: queued || undefined,
    output: "",
    stderr: "",
    usage: emptyUsage(),
    activityLog: [],
    files: opts.files,
    context: opts.context,
    ...inheritanceMetadata,
  });

  let currentState: RunState = "queued";
  let snapshot: SubagentResult = inputFrame(-1, true);
  let result: SubagentResult | undefined;
  let thrown: Error | undefined;
  let settled = false;
  /** Live stdin channel of the current spawn attempt (replaced on fallback retry). */
  let control: SubagentControl | undefined;
  let abortReason: string | undefined;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  let resolvePromise!: (r: SubagentResult) => void;
  const promise = new Promise<SubagentResult>((resolve) => {
    resolvePromise = resolve;
  });

  const notify = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* listener errors never break the run */
      }
    }
  };
  const setFrame = (frame: SubagentResult, state: RunState) => {
    snapshot = frame;
    currentState = state;
    notify();
  };
  const finish = (terminal: SubagentResult, error?: Error, rawOutput?: string) => {
    if (settled) return;
    settled = true;
    if (opts.config.history.enabled) {
      try {
        historyFile = (opts.persistImpl ?? persistSubagentHistory)(
          sessionId, opts.toolCallId, opts.role, opts.task, terminal, rawOutput,
          { runId: opts.id, background: opts.background === true },
        ) || undefined;
      } catch (error: any) {
        try { opts.onHistoryError?.(`Could not persist ${opts.id}; its result remains in memory and may be lost on reload: ${error.message}`); }
        catch { /* reporting errors must not prevent settlement */ }
      }
    }
    result = terminal;
    snapshot = terminal;
    thrown = error;
    currentState = isFailedResult(terminal) ? "failed" : "finished";
    notify();
    opts.signal?.removeEventListener("abort", onCallerAbort);
    resolvePromise(terminal);
  };

  const handle: RunHandle = {
    id: opts.id,
    role: opts.role,
    task: opts.task,
    context: opts.context,
    files: opts.files,
    ...inheritanceMetadata,
    get state() {
      return currentState;
    },
    get snapshot() {
      return snapshot;
    },
    get result() {
      return result;
    },
    get thrown() {
      return thrown;
    },
    get historyFile() {
      return historyFile;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    abort(reason?: string) {
      if (settled) return;
      if (reason) abortReason = reason;
      controller.abort();
    },
    steer(message: string) {
      if (settled || currentState !== "running") return;
      control?.steer(message);
    },
    promise,
  };

  (async () => {
    // ── Concurrency gate (abortable while queued) ──
    try {
      await opts.gate.acquire(controller.signal);
    } catch {
      const msg = "still queued for a concurrency slot" + (abortReason ? ` (${abortReason})` : "");
      finish(
        { ...inputFrame(1, false), stopReason: "cancelled", errorMessage: msg },
        new Error(msg),
      );
      return;
    }

    let completedResult: SubagentResult | undefined;
    let completedRawOutput: string | undefined;
    try {
      // Resolve the model AFTER acquiring so the queued period stays zero-cost.
      let rolesApi: ModelRolesAPI;
      try {
        rolesApi = opts.getRolesApi();
      } catch {
        finish({
          ...inputFrame(1, false),
          errorMessage: "pi-model-roles is not initialized. Cannot resolve model for subagent.",
        });
        return;
      }

      let modelRef: string;
      let thinking: ThinkingLevel | undefined;
      if (opts.modelOverride) {
        modelRef = opts.modelOverride;
      } else {
        const resolved = await abortable(() => rolesApi.resolveRoleAsync(opts.roleDef.role), controller.signal);
        if (!resolved.model) {
          finish({
            ...inputFrame(1, false),
            errorMessage: `Role "${opts.roleDef.role}" could not be resolved. Model not available.`,
          });
          return;
        }
        modelRef = `${resolved.model.provider}/${resolved.model.id}`;
        thinking = resolved.config.thinking;
      }

      const startTime = Date.now();
      /** Snapshot of a failed first attempt; set before a fallback retry spawns so running frames can show the trace. */
      let activeFallbackFrom: FallbackFrom | undefined;
      // Total active-time budget for this run (ms). The clock pauses while the
      // child delegates, so this caps *active* time, not wall time.
      const timeoutBudgetMs = effectiveTimeout(opts.roleDef) * 1000;
      const maxTurns = opts.roleDef.maxTurns ?? opts.config.maxTurns;
      const maxCost = opts.roleDef.maxCost ?? opts.config.maxCost;

      // Every progress partial becomes a full TUI-ready frame.
      const liveFrame = (partial: Partial<SubagentResult>): SubagentResult => ({
        role: opts.role,
        task: opts.task,
        exitCode: -1,
        output: partial.output ?? "",
        stderr: "",
        usage: partial.usage ?? emptyUsage(),
        model: partial.model,
        stopReason: partial.stopReason,
        activityLog: partial.activityLog ?? [],
        startTime,
        budgetMs: timeoutBudgetMs,
        graceMs: partial.graceMs,
        pauseStart: partial.pauseStart,
        files: opts.files,
        context: opts.context,
        ...inheritanceMetadata,
        fallbackFrom: activeFallbackFrom,
      });
      const emitProgress = (partial: Partial<SubagentResult>) =>
        setFrame(liveFrame(partial), "running");

      // Running placeholder now that we hold a slot.
      setFrame(liveFrame({}), "running");

      let runResult = await spawn(modelRef, opts.task, {
        cwd: opts.cwd,
        thinking,
        tools: opts.roleDef.tools,
        excludeTools: opts.roleDef.excludeTools,
        systemPrompt: opts.roleDef.systemPrompt,
        context: opts.context,
        contextFiles: opts.files,
        inheritConversation: opts.inheritConversation,
        inheritedConversation: opts.inheritedConversation,
        subagentRoles: opts.roleDef.subagentRoles,
        timeoutMs: timeoutBudgetMs,
        maxTurns,
        maxCost,
        depth: opts.depth,
        signal: controller.signal,
        onProgress: emitProgress,
        onControl: (c) => {
          control = c;
        },
      });
      completedResult = runResult;

      // Retry with fallback role on provider errors (quota, auth, timeout, etc.)
      if (
        (runResult.exitCode !== 0 || runResult.errorMessage) &&
        opts.roleDef.fallbackRole &&
        isProviderError(runResult)
      ) {
        const fallback = await abortable(() => rolesApi.resolveRoleAsync(opts.roleDef.fallbackRole!), controller.signal);
        if (fallback.model) {
          const fbRef = `${fallback.model.provider}/${fallback.model.id}`;
          // Snapshot the failed first attempt BEFORE the retry — spawn returns
          // a fresh object, but building the snapshot up front also keeps it
          // if the retry throws (abort). modelRef fills the model field when
          // the child died before any message_end; activeFallbackFrom threads
          // the trace into running frames while the retry is in flight.
          const fallbackFrom = buildFallbackFrom(runResult, modelRef);
          activeFallbackFrom = fallbackFrom;
          completedResult = undefined;
          runResult = await spawn(fbRef, opts.task, {
            cwd: opts.cwd,
            thinking: fallback.config.thinking,
            tools: opts.roleDef.tools,
            excludeTools: opts.roleDef.excludeTools,
            systemPrompt: opts.roleDef.systemPrompt,
            context: opts.context,
            contextFiles: opts.files,
            inheritConversation: opts.inheritConversation,
            inheritedConversation: opts.inheritedConversation,
            subagentRoles: opts.roleDef.subagentRoles,
            timeoutMs: timeoutBudgetMs,
            maxTurns,
            maxCost,
            depth: opts.depth,
            signal: controller.signal,
            onProgress: emitProgress,
            onControl: (c) => {
              control = c;
            },
          });
          runResult.fallbackFrom = fallbackFrom;
          completedResult = runResult;
        }
      }

      // Stamp terminal fields once, after any fallback retry: elapsedMs covers
      // the whole delegate span (incl. retry); role/files/context mirror the
      // delegate params (spawn never learns the registry role name).
      runResult.role = opts.role;
      runResult.files = opts.files;
      runResult.context = opts.context;
      Object.assign(runResult, inheritanceMetadata);
      runResult.elapsedMs = Date.now() - startTime;

      // Compress/truncate oversized output before it reaches the main model or TUI.
      // Keep the raw original for the history file (audit), feed the prepared text to LLM + expanded view.
      const rawOutput = runResult.output;
      completedRawOutput = rawOutput;
      if (runResult.output.length > MAX_OUTPUT_CHARS) {
        const { text, method } = await abortable(() => compressOutput(
          rolesApi,
          runResult.output,
          opts.task,
          opts.config.summary,
          controller.signal,
        ), controller.signal);
        runResult.output = text;
        runResult.outputMethod = method;
      } else {
        runResult.outputMethod = "raw";
      }

      // Generate summary for TUI display
      if (opts.config.summary.enabled && runResult.output.trim()) {
        runResult.summary = await abortable(
          () => generateSummary(rolesApi, runResult.output, opts.config.summary, controller.signal),
          controller.signal,
        );
      }

      controller.signal.throwIfAborted();
      finish(runResult, undefined, rawOutput);
    } catch (err: any) {
      // A completed child may still be awaiting compression/summary; preserve
      // its full result when cancellation interrupts that post-processing.
      const partial = completedResult ?? snapshot;
      // Aborts settle as their own stop reason ("cancelled", same family as
      // timeout/budget: intentional stop with partial output) and the abort
      // reason becomes the error message verbatim — no wrapper needed, every
      // renderer already prefixes "cancelled". Non-abort crashes (spawn
      // failure) keep the plain thrown message.
      const wasCancelled = controller.signal.aborted;
      const terminal: SubagentResult = {
        ...inputFrame(1, false),
        output: partial.output.length > MAX_OUTPUT_CHARS ? truncateOutput(partial.output) : partial.output,
        outputMethod: partial.output.length > MAX_OUTPUT_CHARS ? "truncated" : (partial.outputMethod ?? "raw"),
        stderr: partial.stderr,
        fallbackFrom: partial.fallbackFrom,
        usage: partial.usage,
        model: partial.model,
        stopReason: wasCancelled ? "cancelled" : undefined,
        activityLog: partial.activityLog,
        budgetMs: partial.budgetMs,
        elapsedMs: partial.elapsedMs ?? (partial.startTime ? Date.now() - partial.startTime : undefined),
        errorMessage: wasCancelled ? abortReason || "cancelled" : err?.message || String(err),
      };
      finish(terminal, err instanceof Error ? err : new Error(String(err)), completedRawOutput ?? partial.output);
    } finally {
      opts.gate.release();
    }
  })();

  return handle;
}
