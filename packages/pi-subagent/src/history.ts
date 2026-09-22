/** Persistent terminal results and bounded metadata for the session run registry. */
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { SubagentResult } from "./types.ts";
import { emptyUsage, MAX_OUTPUT_CHARS, sanitizeFilename, taskPreview } from "./utils.ts";

export interface HistoryIdentity {
  runId: string;
  background: boolean;
}

export interface HistoryEntry extends HistoryIdentity {
  file: string;
  toolCallId: string;
  snapshot: SubagentResult;
}

/** Body-free metadata: never retain output, activity, context, files, or stderr. */
export function summarizeResult(r: SubagentResult): SubagentResult {
  const summary: SubagentResult = {
    role: r.role,
    task: taskPreview(r.task),
    exitCode: r.exitCode,
    output: "",
    stderr: "",
    activityLog: [],
    usage: { ...r.usage },
    model: r.model,
    stopReason: r.stopReason,
    errorMessage: r.errorMessage ? taskPreview(r.errorMessage) : undefined,
    summary: taskPreview(r.summary || r.output),
    elapsedMs: r.elapsedMs,
    budgetMs: r.budgetMs,
    outputMethod: r.outputMethod,
    inheritConversation: r.inheritConversation,
    inheritedConversationChars: r.inheritedConversationChars,
    inheritedConversationTruncated: r.inheritedConversationTruncated,
  };
  // Detach preview substrings from potentially large V8 backing strings.
  return JSON.parse(JSON.stringify(summary)) as SubagentResult;
}

export function historyDirectory(sessionId: string): string {
  return path.join(os.homedir(), ".pi", "subagent", "history", sanitizeFilename(sessionId));
}

function runNumber(id: unknown): number | undefined {
  if (typeof id !== "string" || !/^sub-\d+$/.test(id)) return undefined;
  const n = Number(id.slice(4));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Reserve a session-local id atomically across processes, including unfinished runs. */
export function reserveHistoryId(directory: string, after: number): string {
  const reservations = path.join(directory, ".ids");
  fs.mkdirSync(reservations, { recursive: true, mode: 0o700 });
  for (let n = after + 1; Number.isSafeInteger(n); n++) {
    const id = `sub-${n}`;
    try {
      const fd = fs.openSync(path.join(reservations, id), "wx", 0o600);
      fs.closeSync(fd);
      return id;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw new Error(`Cannot reserve a subagent id: ${error.message}`);
    }
  }
  throw new Error("Subagent id range exhausted");
}

/** Atomically publish a record. Throws on failure so the caller keeps its in-memory result. */
export function persistSubagentHistory(
  sessionId: string | undefined,
  toolCallId: string,
  role: string,
  task: string,
  r: SubagentResult,
  rawOutput: string | undefined,
  identity: HistoryIdentity,
  /** @internal — explicit sandbox directory for offline tests. */
  directory?: string,
): string {
  const dir = directory ?? historyDirectory(sessionId ?? "unknown");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sanitizeFilename(toolCallId)}.json`);
  const temp = `${file}.${randomUUID()}.tmp`;
  const payload = {
    id: toolCallId,
    role,
    task,
    timestamp: Date.now(),
    // Preserve the audit format's raw output; result is the exact delivered frame.
    output: rawOutput ?? r.output,
    version: 2,
    ...identity,
    result: r,
  };
  try {
    fs.writeFileSync(temp, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    return file;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResult(value: unknown): value is SubagentResult {
  if (!isObject(value) || typeof value.role !== "string" || typeof value.task !== "string" ||
      !Number.isInteger(value.exitCode) || value.exitCode < 0 || typeof value.output !== "string" ||
      typeof value.stderr !== "string" || !Array.isArray(value.activityLog) || !isObject(value.usage)) return false;
  if (!Object.keys(emptyUsage()).every((key) => typeof value.usage[key] === "number" && Number.isFinite(value.usage[key]))) return false;
  if (!value.activityLog.every((entry: unknown) => isObject(entry) &&
      ["thinking", "toolCall", "text", "steer"].includes(entry.kind) && typeof entry.id === "string" &&
      ["queued", "running", "done", "failed"].includes(entry.status) &&
      (entry.text === undefined || typeof entry.text === "string") &&
      (entry.toolName === undefined || typeof entry.toolName === "string") &&
      (entry.args === undefined || isObject(entry.args)))) return false;
  for (const key of ["summary", "model", "stopReason", "errorMessage", "context"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (value.files !== undefined && (!Array.isArray(value.files) || !value.files.every((f: unknown) => typeof f === "string"))) return false;
  for (const key of ["elapsedMs", "budgetMs", "inheritedConversationChars"]) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) return false;
  }
  if (value.fallbackFrom !== undefined && (!isObject(value.fallbackFrom) ||
      !Object.values(value.fallbackFrom).every((field) => field === undefined || typeof field === "string"))) return false;
  return true;
}

function decodeRecord(raw: unknown): { data: Record<string, any>; result: SubagentResult } {
  if (!isObject(raw) || typeof raw.id !== "string") throw new Error("Invalid subagent history record");
  if (raw.version !== undefined && raw.version !== 2) throw new Error("Unsupported subagent history version");
  let result = raw.result;
  if (raw.version === undefined) {
    result = { ...raw, stderr: raw.stderr ?? "", usage: { ...emptyUsage(), ...raw.usage } };
    // Legacy records only contain raw output, which may exceed the delivery limit.
    if (typeof result.output === "string" && result.output.length > MAX_OUTPUT_CHARS) {
      const marker = "\n\n[Legacy history output truncated]\n\n";
      const head = Math.floor((MAX_OUTPUT_CHARS - marker.length) * 0.8);
      result.output = result.output.slice(0, head) + marker + result.output.slice(-(MAX_OUTPUT_CHARS - marker.length - head));
      result.outputMethod = "truncated";
    } else result.outputMethod = "raw";
  }
  if (!isResult(result)) throw new Error("Invalid subagent history result");
  return { data: raw, result };
}

export function readHistoryResult(file: string): SubagentResult {
  return decodeRecord(JSON.parse(fs.readFileSync(file, "utf8"))).result;
}

interface LegacyHint { runId?: string; background: boolean }

/** Recover old toolCallId → run id mappings across all branches, not just active context. */
function sessionHints(entries: readonly unknown[]): { hints: Map<string, LegacyHint>; maxId: number } {
  const hints = new Map<string, LegacyHint>();
  let maxId = 0;
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message)) continue;
    const m = entry.message;
    if (m.role !== "toolResult" || !isObject(m.details)) continue;
    const id = m.details.id;
    maxId = Math.max(maxId, runNumber(id) ?? 0);
    if (m.toolName !== "subagent_delegate" || typeof m.toolCallId !== "string") continue;
    if (runNumber(id) !== undefined) hints.set(m.toolCallId, { runId: id, background: true });
    else if (Array.isArray(m.details.results)) hints.set(m.toolCallId, { background: false });
  }
  return { hints, maxId };
}

/** Scan one record at a time; only bounded metadata remains resident after startup. */
export function loadHistoryIndex(
  directory: string | undefined,
  sessionEntries: readonly unknown[],
  warn: (message: string) => void,
): { entries: HistoryEntry[]; maxId: number } {
  const { hints, maxId: sessionMax } = sessionHints(sessionEntries);
  let maxId = sessionMax;
  const entries: HistoryEntry[] = [];
  if (!directory) return { entries, maxId };
  try {
    for (const id of fs.readdirSync(path.join(directory, ".ids"))) maxId = Math.max(maxId, runNumber(id) ?? 0);
  } catch (error: any) {
    if (error.code !== "ENOENT") warn(`Cannot read subagent id reservations: ${error.message}`);
  }
  let names: string[];
  try { names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort(); }
  catch (error: any) {
    if (error.code !== "ENOENT") warn(`Cannot read subagent history: ${error.message}`);
    return { entries, maxId };
  }
  const pending: Array<Omit<HistoryEntry, "runId"> & { runId?: string }> = [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      // Reserve a recognizable id even when its result is damaged.
      if (isObject(raw)) maxId = Math.max(maxId, runNumber(raw.runId) ?? 0);
      const { data, result } = decodeRecord(raw);
      const hint = data.version === 2 ? { runId: data.runId, background: data.background } : hints.get(data.id);
      if (!hint) continue;
      if (data.version === 2 && typeof hint.runId !== "string") throw new Error("Missing run identity");
      if (typeof hint.background !== "boolean" || (hint.runId !== undefined &&
          runNumber(hint.runId) === undefined)) throw new Error("Invalid run identity");
      if (hint.runId) maxId = Math.max(maxId, Number(hint.runId.slice(4)));
      pending.push({ file, toolCallId: data.id, ...hint, snapshot: summarizeResult(result) });
    } catch (error: any) { warn(`Cannot restore subagent history ${name}: ${error.message}`); }
  }
  const counts = new Map<string, number>();
  for (const entry of pending) {
    if (entry.runId) counts.set(entry.runId, (counts.get(entry.runId) ?? 0) + 1);
  }
  const warned = new Set<string>();
  let legacyCounter = 0;
  for (const entry of pending) {
    // Old foreground calls never exposed a run id. Keep their display ids
    // separate from ids reserved by concurrent writers.
    const runId = entry.runId ?? `legacy-${++legacyCounter}`;
    if ((counts.get(runId) ?? 0) > 1) {
      if (!warned.has(runId)) warn(`Ambiguous subagent id ${runId} in history; its duplicate records were not restored.`);
      warned.add(runId);
      continue;
    }
    entries.push({ ...entry, runId });
  }
  entries.sort((a, b) => (runNumber(a.runId) ?? 0) - (runNumber(b.runId) ?? 0));
  return { entries, maxId };
}
