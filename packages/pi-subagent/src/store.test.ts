import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunStore } from "./store.ts";
import { persistSubagentHistory, readHistoryResult } from "./history.ts";
import { startSubagentRun, type StartRunOptions } from "./run.ts";
import { DEFAULT_CONFIG, type SubagentResult } from "./types.ts";
import { AsyncSemaphore, emptyUsage } from "./utils.ts";
import { buildInboxReminder } from "./reminder.ts";

function sandbox(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-store-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function frame(output: string): SubagentResult {
  return { role: "explorer", task: "long task ".repeat(1000), exitCode: 0, output, stderr: "",
    activityLog: [{ kind: "text", id: "text-1", status: "done", text: output }],
    context: "large context", files: ["some-file"], usage: emptyUsage(), elapsedMs: 3000 };
}

function options(dir: string, id: string): StartRunOptions {
  return {
    id, toolCallId: `call-${id}`, role: "explorer", task: "test", cwd: dir, depth: 1,
    roleDef: { role: "fast", description: "", examples: [], decisionTrigger: "", systemPrompt: "" },
    gate: new AsyncSemaphore(4),
    config: { ...DEFAULT_CONFIG, summary: { enabled: false, role: "utility" } },
    getSessionId: () => "test-session",
    getRolesApi: () => ({ resolveRoleAsync: async () => ({ model: { provider: "fake", id: "model" }, config: {} }) }) as any,
    spawnImpl: async () => frame("full result"),
    persistImpl: (session, call, role, task, result, raw, identity) =>
      persistSubagentHistory(session, call, role, task, result, raw, identity, dir),
  };
}

test("settlement releases the engine and bodies while check and view can reload them", async (t) => {
  const dir = sandbox(t);
  let reads = 0;
  const store = new RunStore((file) => { reads++; return readHistoryResult(file); });
  const live = startSubagentRun(options(dir, store.nextId()));
  store.add(live, true);
  const indexed = store.background.get(live.id)!;
  const full = await live.promise;
  assert.equal(indexed.state, "finished");
  assert.equal(indexed.snapshot.output, "");
  assert.equal((await indexed.promise).output, "");
  assert.deepEqual(indexed.snapshot.activityLog, []);
  assert.equal(indexed.snapshot.context, undefined);
  assert.ok(indexed.task.length <= 73);
  assert.equal(reads, 0);
  assert.deepEqual(store.read(indexed), JSON.parse(JSON.stringify(full)));
  assert.equal(reads, 1);
  store.evict(indexed.id);
  assert.deepEqual(store.read(indexed), JSON.parse(JSON.stringify(full)));
  assert.equal(reads, 2);
  const view = store.view(indexed);
  assert.equal(view.task, full.task);
  assert.deepEqual(view.snapshot.activityLog, full.activityLog);
  assert.equal(reads, 2);
  store.evict();
  store.view(indexed);
  assert.equal(reads, 3);
});

test("the terminal cache keeps at most one loaded result and reload restores only metadata", (t) => {
  const dir = sandbox(t);
  for (let n = 1; n <= 3; n++) {
    const r = frame(`body-${n}`);
    persistSubagentHistory("s", `call-${n}`, r.role, r.task, r, undefined, { runId: `sub-${n}`, background: n < 3 }, dir);
  }
  let reads = 0;
  const store = new RunStore((file) => { reads++; return readHistoryResult(file); });
  store.restore(dir, [], assert.fail);
  assert.equal(reads, 0);
  assert.equal(store.background.size, 2);
  assert.equal(store.foreground.size, 1);
  assert.equal(store.nextId(), "sub-4");
  const a = store.background.get("sub-1")!;
  const b = store.background.get("sub-2")!;
  store.read(a); store.read(a);
  assert.equal(reads, 1);
  store.read(b); store.read(a);
  assert.equal(reads, 3);
  const delivered = new Set(["sub-1"]);
  assert.ok(!buildInboxReminder(store.background.values(), delivered)?.includes("- sub-1"));
  assert.ok(buildInboxReminder(store.background.values(), new Set())?.includes("- sub-1"));
  assert.equal(reads, 3, "inbox reads metadata only");
  store.restore(dir, [], assert.fail);
  store.read(store.background.get("sub-1")!);
  assert.equal(reads, 4);
  store.restore(path.join(dir, "other-session"), [], assert.fail);
  assert.equal(store.background.size, 0);
  assert.equal(store.foreground.size, 0);
});

test("disabled or failed persistence keeps the only full result in memory", async (t) => {
  const dir = sandbox(t);
  for (const enabled of [false, true]) {
    const store = new RunStore(() => { throw new Error("unexpected disk read"); });
    const warnings: string[] = [];
    const opts = options(dir, store.nextId());
    opts.config = { ...opts.config, history: { enabled } };
    opts.persistImpl = () => { throw new Error("disk full"); };
    opts.onHistoryError = (m) => warnings.push(m);
    const live = startSubagentRun(opts);
    store.add(live, false);
    const full = await live.promise;
    store.evict();
    assert.equal(store.read(store.foreground.get(live.id)!), full);
    assert.equal(warnings.length, enabled ? 1 : 0);
    if (enabled) assert.match(warnings[0], /remains in memory/);
  }
});

test("missing history is reported instead of returning an empty successful result", (t) => {
  const dir = sandbox(t);
  const r = frame("answer");
  const file = persistSubagentHistory("s", "call", r.role, r.task, r, undefined, { runId: "sub-1", background: true }, dir);
  const store = new RunStore();
  store.restore(dir, [], assert.fail);
  fs.unlinkSync(file);
  assert.throws(() => store.read(store.background.get("sub-1")!), /Cannot load subagent sub-1/);
});

test("independent registries reserve distinct ids before either task reaches the ledger", (t) => {
  const dir = sandbox(t);
  const a = new RunStore();
  const b = new RunStore();
  a.restore(dir, [], assert.fail);
  b.restore(dir, [], assert.fail);
  assert.equal(a.nextId(), "sub-1");
  assert.equal(b.nextId(), "sub-2");
  assert.equal(a.nextId(), "sub-3");
  const reopened = new RunStore();
  reopened.restore(dir, [], assert.fail);
  assert.equal(reopened.nextId(), "sub-4", "unfinished ids are not reused after reopening");
  assert.equal(reopened.background.size, 0);
});

test("an id reservation failure never falls back to a colliding local counter", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, ".ids"), "not a directory");
  const store = new RunStore();
  store.restore(dir, [], () => {});
  assert.throws(() => store.nextId());
});
