import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";
import subagentExtension from "./index.ts";
import { startSubagentRun, type RunHandle, type StartRunOptions } from "./run.ts";
import { persistSubagentHistory } from "./history.ts";
import { emptyUsage } from "./utils.ts";

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lifecycle-test-"));
  const env = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_ALLOWED", "PI_SUBAGENT_DEPTH"];
  const previous = env.map((key) => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  delete process.env.PI_SUBAGENT_ALLOWED;
  delete process.env.PI_SUBAGENT_DEPTH;
  t.mock.method(paletteCommandRegistry, "register", () => {});
  t.after(() => {
    env.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, ".pi"));
  fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ subagent: { summary: { enabled: false }, maxConcurrency: 1 } }));
  const historyDir = (id: string) => path.join(dir, "history", id);
  const entries: any[] = [];
  let activeEntries = entries;
  let sessionId = "session-a";
  const notices: any[] = [];
  const warnings: string[] = [];
  const runs: RunHandle[] = [];
  let spawn: NonNullable<StartRunOptions["spawnImpl"]> = async () => ({
    role: "explorer", task: "task", exitCode: 0, output: "durable answer", stderr: "",
    usage: { ...emptyUsage(), turns: 2 },
    activityLog: [{ kind: "text", id: "text-1", status: "done", text: "durable activity" }],
  });
  const ctx: any = {
    cwd: dir, mode: "print",
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
      buildContextEntries: () => activeEntries,
    },
    ui: { notify: (message: string) => warnings.push(message) },
  };
  function runtime() {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const hooks = new Map<string, any>();
    subagentExtension({
      on: (event: string, fn: any) => hooks.set(event, fn),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      registerMessageRenderer() {},
      sendMessage: (message: any) => notices.push(message),
    } as unknown as ExtensionAPI, {
      historyDirectory: historyDir,
      availabilityPath: path.join(dir, "availability.json"),
      startRun: (opts) => {
        const run = startSubagentRun({
          ...opts, spawnImpl: (...args) => spawn(...args),
          getRolesApi: () => ({ resolveRoleAsync: async () => ({ model: { provider: "fake", id: "model" }, config: {} }) }) as any,
          persistImpl: (session, call, role, task, result, raw, identity) =>
            persistSubagentHistory(session, call, role, task, result, raw, identity, historyDir(session!)),
        });
        runs.push(run);
        return run;
      },
    });
    return {
      async start() { await hooks.get("session_start")({ reason: "reload" }, ctx); },
      async shutdown() { await hooks.get("session_shutdown")({ reason: "reload" }, ctx); },
      async call(name: string, params: any, id = `call-${entries.length}`, signal?: AbortSignal) {
        const result = await tools.get(name).execute(id, params, signal, undefined, ctx);
        entries.push({ type: "message", message: { role: "toolResult", toolName: name, toolCallId: id, ...result } });
        return result;
      },
      async reminder() {
        return hooks.get("context")({ messages: [{ role: "user", content: "continue", timestamp: 0 }] }, ctx);
      },
      commands,
    };
  }
  return {
    runtime, runs, ctx, notices, warnings, entries, historyDir,
    setSpawn(value: typeof spawn) { spawn = value; },
    branch(value: any[]) { activeEntries = value; },
    switchSession(id: string) { sessionId = id; entries.length = 0; },
  };
}

test("background check stays repeatable across reload, branches, and reopening the session", async (t) => {
  const h = setup(t);
  let runtime = h.runtime();
  await runtime.start();
  const started = await runtime.call("subagent_delegate", { role: "explorer", task: "inspect", background: true }, "delegate-1");
  assert.equal(started.details.id, "sub-1");
  await h.runs[0].promise;
  const first = await runtime.call("subagent_check", { id: "sub-1" });
  const second = await runtime.call("subagent_check", { id: "sub-1" });
  assert.deepEqual(first, second);
  assert.equal(await runtime.reminder(), undefined);
  await runtime.shutdown();
  runtime = h.runtime();
  await runtime.start();
  assert.equal(h.notices.length, 1, "restoring does not emit another completion notice");
  const restored = await runtime.call("subagent_check", { id: "sub-1" });
  assert.deepEqual(restored, first);
  h.branch([h.entries[0]]);
  assert.match(JSON.stringify(await runtime.reminder()), /Ended.*sub-1/s);
  const waited = await runtime.call("subagent_wait", { ids: ["sub-1"] });
  assert.match(waited.content[0].text, /finished/);
  assert.equal(waited.details.entries[0].result.output, "", "wait does not hydrate history");
  const next = await runtime.call("subagent_delegate", { role: "explorer", task: "another", background: true }, "delegate-2");
  assert.equal(next.details.id, "sub-2");
  await h.runs[1].promise;
  await runtime.shutdown();
  h.switchSession("session-b");
  runtime = h.runtime();
  await runtime.start();
  await assert.rejects(runtime.call("subagent_check", { id: "sub-1" }), /Unknown subagent/);
  h.switchSession("session-a");
  runtime = h.runtime();
  await runtime.start();
  assert.deepEqual(await runtime.call("subagent_check", { id: "sub-1" }), first);
  assert.deepEqual(h.warnings, []);
});

test("parent-turn abort retains the aborted label and partial output in foreground tool text", async (t) => {
  const h = setup(t);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.setSpawn(async (_model, _task, opts) => {
    opts.onProgress?.({ output: "partial findings", usage: { ...emptyUsage(), turns: 1 } });
    entered();
    await new Promise<void>((_resolve, reject) => {
      opts.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    throw new Error("unreachable");
  });
  const runtime = h.runtime();
  await runtime.start();
  const caller = new AbortController();
  const delegated = runtime.call("subagent_delegate", { role: "explorer", task: "inspect" }, "foreground-call", caller.signal);
  await started;
  caller.abort();
  const result = await delegated;
  assert.equal(h.runs[0].state, "aborted");
  assert.match(result.content[0].text, /^explorer: aborted — .*Partial output:\npartial findings/s);
  assert.equal(result.details.results[0].stopReason, "aborted");
  assert.equal(h.notices.length, 0);
  await runtime.shutdown();
});

for (const source of ["child", "tool", "command"] as const) {
  test(`${source} interruption retains its terminal state across notices, wait, check, and reload`, async (t) => {
    const h = setup(t);
    const expectedState = source === "child" ? "aborted" : "cancelled";
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const childSettlement = new Promise<void>((resolve) => { release = resolve; });
    h.setSpawn(async (_model, _task, opts) => {
      entered();
      const partial = {
        output: "partial findings", usage: { ...emptyUsage(), turns: 1 },
        activityLog: [{ kind: "text" as const, id: "text-1", status: "done" as const, text: "partial findings" }],
      };
      opts.onProgress?.(partial);
      if (source === "child") {
        await childSettlement;
        return {
          role: "", task: "", exitCode: 0, stderr: "",
          ...partial, stopReason: "aborted", errorMessage: "Subagent run was aborted",
        };
      }
      await new Promise<void>((_resolve, reject) => {
        opts.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    });
    let runtime = h.runtime();
    await runtime.start();
    await runtime.call("subagent_delegate", { role: "explorer", task: "inspect", background: true }, "delegate-1");
    await started;
    if (source === "child") release();
    else if (source === "tool") await runtime.call("subagent_cancel", { id: "sub-1", reason: "no longer needed" });
    else await runtime.commands.get("subagent:cancel").handler("sub-1 no longer needed", h.ctx);
    await h.runs[0].promise;
    assert.equal(h.runs[0].state, expectedState);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].details.outcome, expectedState);
    assert.match(JSON.stringify(await runtime.reminder()), new RegExp(`Ended.*${expectedState}`, "s"));
    const waited = await runtime.call("subagent_wait", { ids: ["sub-1"] });
    assert.match(waited.content[0].text, new RegExp(`: ${expectedState}`));
    const checked = await runtime.call("subagent_check", { id: "sub-1" });
    assert.match(checked.content[0].text, new RegExp(`: ${expectedState}.*Partial output:`, "s"));
    assert.equal(checked.details.result.output, "partial findings");
    const again = await runtime.call("subagent_cancel", { id: "sub-1" });
    assert.match(again.content[0].text, new RegExp(`already ${expectedState}`));
    await assert.rejects(runtime.call("subagent_steer", { id: "sub-1", message: "continue" }), /only running/);
    await runtime.shutdown();
    runtime = h.runtime();
    await runtime.start();
    assert.deepEqual(await runtime.call("subagent_check", { id: "sub-1" }), checked);
    assert.match((await runtime.call("subagent_wait", { ids: ["sub-1"] })).content[0].text, new RegExp(`: ${expectedState}`));
    assert.equal(h.notices.length, 1);
  });
}

test("shutdown waits for running and queued aborts to reach the ledger", async (t) => {
  const h = setup(t);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.setSpawn(async (_model, _task, opts) => {
    entered();
    opts.onProgress?.({ output: "partial before reload", usage: { ...emptyUsage(), turns: 1 } });
    await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => setImmediate(resolve), { once: true }));
    throw new Error("aborted");
  });
  const runtime = h.runtime();
  await runtime.start();
  await runtime.call("subagent_delegate", { role: "explorer", task: "running", background: true }, "running-call");
  await started;
  await runtime.call("subagent_delegate", { role: "explorer", task: "queued", background: true }, "queued-call");
  await runtime.shutdown();
  assert.equal(h.notices.length, 0, "old runtime does not publish completion notices during shutdown");
  const restored = h.runtime();
  await restored.start();
  for (const id of ["sub-1", "sub-2"]) {
    const checked = await restored.call("subagent_check", { id });
    assert.equal(checked.details.result.stopReason, "aborted");
    assert.match(checked.details.result.errorMessage, /session shutdown/);
    if (id === "sub-1") assert.equal(checked.details.result.output, "partial before reload");
  }
});

test("view loads foreground and background history after reopening without requiring a check", async (t) => {
  const h = setup(t);
  let runtime = h.runtime();
  await runtime.start();
  await runtime.call("subagent_delegate", { role: "explorer", task: "foreground" }, "foreground-call");
  await runtime.call("subagent_delegate", { role: "explorer", task: "background", background: true }, "background-call");
  await h.runs[1].promise;
  await runtime.shutdown();
  runtime = h.runtime();
  await runtime.start();
  h.ctx.mode = "tui";
  const seen: string[] = [];
  h.ctx.ui.custom = async (factory: any) => {
    const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
    const panel = factory({ requestRender() {} }, theme, {}, () => {});
    try {
      seen.push(panel.render(100).join("\n"));
      panel.handleInput("\t");
      seen.push(panel.render(100).join("\n"));
    } finally { panel.dispose(); }
  };
  await runtime.commands.get("subagent:view").handler("", h.ctx);
  await runtime.commands.get("subagent:view").handler("", h.ctx);
  assert.equal(seen.length, 4);
  for (const rendered of seen) {
    assert.match(rendered, /2 total/);
    assert.match(rendered, /durable activity/);
  }
  await assert.rejects(runtime.call("subagent_check", { id: "sub-1" }), /Unknown subagent/);
  assert.match((await runtime.call("subagent_check", { id: "sub-2" })).content[0].text, /durable answer/);
});
