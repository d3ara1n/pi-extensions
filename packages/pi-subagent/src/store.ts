/** Session-scoped run index with live controls and a single terminal-result cache. */
import type { RunHandle } from "./run.ts";
import type { SubagentResult } from "./types.ts";
import { isFailedResult } from "./utils.ts";
import { loadHistoryIndex, readHistoryResult, reserveHistoryId, summarizeResult, type HistoryEntry } from "./history.ts";

class StoredRun implements RunHandle {
  readonly id: string;
  private live?: RunHandle;
  private terminal?: SubagentResult;
  historyFile?: string;

  constructor(id: string, live?: RunHandle, terminal?: SubagentResult, file?: string) {
    this.id = id;
    this.live = live;
    this.terminal = terminal;
    this.historyFile = file;
  }

  settle(result: SubagentResult, file?: string): void {
    this.historyFile = file;
    // When persistence fails or is disabled, keep the only surviving result.
    this.terminal = file ? summarizeResult(result) : result;
    // Drop the engine, including its resolved promise and captured input/context.
    this.live = undefined;
  }

  get role() { return this.snapshot.role; }
  get task() { return this.snapshot.task; }
  get state() { return this.live?.state ?? (isFailedResult(this.snapshot) ? "failed" : "finished"); }
  get snapshot(): SubagentResult { return this.live?.snapshot ?? this.terminal!; }
  get result() { return this.live ? this.live.result : this.terminal; }
  get thrown() { return this.live?.thrown; }
  // Waiters need terminal status, not the archived body.
  get promise() { return this.live?.promise ?? Promise.resolve(this.terminal!); }
  abort(reason?: string) { this.live?.abort(reason); }
  steer(message: string) { this.live?.steer(message); }
  subscribe(fn: () => void) { return this.live?.subscribe(fn) ?? (() => {}); }
}

export class RunStore {
  readonly background = new Map<string, RunHandle>();
  readonly foreground = new Map<string, RunHandle>();
  private cache?: { id: string; result: SubagentResult };
  private counter = 0;
  private directory?: string;
  private readonly readResult: (file: string) => SubagentResult;

  constructor(readResult: (file: string) => SubagentResult = readHistoryResult) {
    this.readResult = readResult;
  }

  restore(directory: string | undefined, sessionEntries: readonly unknown[], warn: (message: string) => void): void {
    this.background.clear();
    this.foreground.clear();
    this.cache = undefined;
    this.directory = directory;
    const index = loadHistoryIndex(directory, sessionEntries, warn);
    this.counter = index.maxId;
    for (const entry of index.entries) this.restoreEntry(entry);
  }

  private restoreEntry(entry: HistoryEntry): void {
    const run = new StoredRun(entry.runId, undefined, entry.snapshot, entry.file);
    (entry.background ? this.background : this.foreground).set(run.id, run);
  }

  nextId(): string {
    if (!this.directory) return `sub-${++this.counter}`;
    const id = reserveHistoryId(this.directory, this.counter);
    this.counter = Number(id.slice(4));
    return id;
  }

  add(run: RunHandle, background: boolean): void {
    const stored = new StoredRun(run.id, run);
    const registry = background ? this.background : this.foreground;
    registry.set(run.id, stored);
    void run.promise.then((result) => {
      // A repeated startup must not repopulate the new session's cache.
      if (registry.get(run.id) !== stored) return;
      stored.settle(result, run.historyFile);
    });
  }

  /** Load a full frame for check/view. Metadata-only callers use run.snapshot. */
  read(run: RunHandle): SubagentResult {
    if (this.cache?.id !== run.id) this.cache = undefined;
    if (!run.historyFile) return run.snapshot;
    if (this.cache?.id === run.id) return this.cache.result;
    try {
      const result = this.readResult(run.historyFile);
      this.cache = { id: run.id, result };
      return result;
    } catch (error: any) {
      throw new Error(`Cannot load subagent ${run.id}: ${error.message}`);
    }
  }

  /** Materialize only the focused view entry, preserving lightweight tab metadata. */
  view(run: RunHandle): RunHandle {
    const result = this.read(run);
    return {
      id: run.id,
      role: result.role,
      task: result.task,
      context: result.context,
      files: result.files,
      inheritConversation: result.inheritConversation,
      inheritedConversationChars: result.inheritedConversationChars,
      inheritedConversationTruncated: result.inheritedConversationTruncated,
      state: run.state,
      snapshot: result,
      result: run.result ? result : undefined,
      thrown: run.thrown,
      // No eagerly resolved promise retaining the loaded body.
      get promise() { return run.promise; },
      abort: (reason) => run.abort(reason),
      steer: (message) => run.steer(message),
      subscribe: (fn) => run.subscribe(fn),
    };
  }

  evict(id?: string): void {
    if (id === undefined || this.cache?.id === id) this.cache = undefined;
  }
}
