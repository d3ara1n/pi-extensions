import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadHistoryIndex, persistSubagentHistory, readHistoryResult } from "./history.ts";
import { emptyUsage, MAX_OUTPUT_CHARS } from "./utils.ts";
import type { SubagentResult } from "./types.ts";

function result(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    role: "explorer", task: "inspect the project", exitCode: 0, output: "prepared answer",
    stderr: "", usage: { ...emptyUsage(), turns: 2, cost: 0.2 },
    activityLog: [{ kind: "text", id: "text-1", status: "done", text: "full activity" }],
    context: "reference context", files: ["src/index.ts"], elapsedMs: 1000,
    outputMethod: "compressed", ...overrides,
  };
}

function sandbox(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-history-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("history round-trips the delivered result separately from raw audit output", (t) => {
  const dir = sandbox(t);
  const r = result({ fallbackFrom: { model: "first", errorMessage: "quota exceeded" }, inheritConversation: true });
  const file = persistSubagentHistory("session", "call-1", r.role, r.task, r, "original raw answer", { runId: "sub-3", background: true }, dir);
  assert.deepEqual(readHistoryResult(file), r);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).output, "original raw answer");
  assert.deepEqual(fs.readdirSync(dir), ["call-1.json"]);
  const warnings: string[] = [];
  const index = loadHistoryIndex(dir, [], (m) => warnings.push(m));
  assert.deepEqual(warnings, []);
  assert.equal(index.maxId, 3);
  assert.equal(index.entries[0].runId, "sub-3");
  assert.equal(index.entries[0].snapshot.output, "");
  assert.deepEqual(index.entries[0].snapshot.activityLog, []);
  assert.equal(index.entries[0].snapshot.context, undefined);
  assert.equal(index.entries[0].snapshot.files, undefined);
  assert.deepEqual(index.entries[0].snapshot.usage, r.usage);
});

test("an atomic write failure preserves the previous record and removes temporary files", (t) => {
  const dir = sandbox(t);
  const r = result();
  const file = persistSubagentHistory("s", "call", r.role, r.task, r, undefined, { runId: "sub-1", background: false }, dir);
  const broken = result();
  (broken.activityLog[0] as any).circular = broken;
  assert.throws(() => persistSubagentHistory("s", "call", r.role, r.task, broken, undefined, { runId: "sub-1", background: false }, dir));
  assert.deepEqual(readHistoryResult(file), r);
  assert.deepEqual(fs.readdirSync(dir), ["call.json"]);
});

test("legacy history joins delegate ids from all session entries and bounds raw output", (t) => {
  const dir = sandbox(t);
  const legacy = { ...result(), id: "old-call", output: "x".repeat(MAX_OUTPUT_CHARS * 2) };
  delete (legacy as any).stderr;
  fs.writeFileSync(path.join(dir, "old-call.json"), JSON.stringify(legacy));
  fs.writeFileSync(path.join(dir, "fg-call.json"), JSON.stringify({ ...result(), id: "fg-call" }));
  const entries = [
    { type: "message", message: { role: "toolResult", toolName: "subagent_delegate", toolCallId: "old-call", details: { id: "sub-7" } } },
    { type: "message", message: { role: "toolResult", toolName: "subagent_delegate", toolCallId: "fg-call", details: { results: [result()] } } },
  ];
  const index = loadHistoryIndex(dir, entries, assert.fail);
  const background = index.entries.find((e) => e.background)!;
  const foreground = index.entries.find((e) => !e.background)!;
  assert.equal(background.runId, "sub-7");
  assert.equal(foreground.runId, "legacy-1");
  const loaded = readHistoryResult(background.file);
  assert.equal(loaded.output.length, MAX_OUTPUT_CHARS);
  assert.equal(loaded.outputMethod, "truncated");
  assert.equal(loaded.stderr, "");
});

test("corrupt records are isolated and old ids are reserved even without history", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  fs.writeFileSync(path.join(dir, "bad-result.json"), JSON.stringify({ version: 2, id: "bad", result: result({ usage: {} as any }) }));
  fs.writeFileSync(path.join(dir, "future.json"), JSON.stringify({ version: 3, id: "future" }));
  const r = result();
  persistSubagentHistory("s", "good", r.role, r.task, r, undefined, { runId: "sub-2", background: false }, dir);
  const messages: string[] = [];
  const index = loadHistoryIndex(dir, [], (m) => messages.push(m));
  assert.equal(index.entries.length, 1);
  assert.equal(messages.length, 3);
  const entries = [{ type: "message", message: { role: "toolResult", details: { id: "sub-19" } } }];
  assert.equal(loadHistoryIndex(undefined, entries, assert.fail).maxId, 19);
  assert.deepEqual(loadHistoryIndex(path.join(dir, "missing"), [], assert.fail).entries, []);
});

test("duplicate ids do not silently replace another task", (t) => {
  const dir = sandbox(t);
  const r = result();
  for (const id of ["a", "b"]) persistSubagentHistory("s", id, r.role, r.task, r, undefined, { runId: "sub-1", background: true }, dir);
  const warnings: string[] = [];
  const index = loadHistoryIndex(dir, [], (m) => warnings.push(m));
  assert.equal(index.entries.length, 0, "ambiguous ids must not resolve to an arbitrary result");
  assert.match(warnings[0], /Ambiguous/);
});

test("a damaged result still reserves its recognizable id", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, "broken-result.json"), JSON.stringify({ version: 2, id: "call", runId: "sub-28", result: null }));
  const warnings: string[] = [];
  const index = loadHistoryIndex(dir, [], (message) => warnings.push(message));
  assert.equal(index.maxId, 28);
  assert.equal(index.entries.length, 0);
  assert.equal(warnings.length, 1);
});
