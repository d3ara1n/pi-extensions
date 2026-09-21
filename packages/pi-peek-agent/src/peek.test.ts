import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InvestigateOptions, PeekReferenceOptions } from "@d3ara1n/pi-peek";
import register from "./index.ts";
import { MESH_GLOBAL_KEY } from "../../pi-mesh/src/types.ts";
import { PEEK_GLOBAL_KEY } from "../../pi-peek/src/types.ts";

const globals = globalThis as unknown as Record<string, unknown>;

test("remote handler creates independent investigations, forwards stages and keeps the report protocol", async () => {
  const saved = globals[PEEK_GLOBAL_KEY];
  const questions: string[] = [];
  const thinkingFlags: (boolean | undefined)[] = [];
  const usage = { input: 10, output: 2, cacheRead: 30, cacheWrite: 0, total: 42, cost: 0.01 };
  globals[PEEK_GLOBAL_KEY] = {
    async investigate(question: string, opts: InvestigateOptions & PeekReferenceOptions) {
      questions.push(question);
      thinkingFlags.push(opts.includeThinking);
      opts.onStage?.("investigating");
      opts.onToken?.("report");
      return { report: `report ${question}`, snapshotAt: "fixed", stopReason: "stop", usage };
    },
  };
  try {
    let ready!: (mesh: unknown) => void;
    let handler!: (data: unknown, emit: (type: string, data?: unknown) => void) => Promise<unknown>;
    register({
      events: { on: (_name: string, fn: typeof ready) => { ready = fn; } },
      on() {}, registerTool() {},
    } as unknown as ExtensionAPI);
    ready({ serve: (_type: string, fn: typeof handler) => { handler = fn; } });
    const emitted: string[] = [];
    const first = await handler({ question: "one" }, type => { emitted.push(type); });
    const second = await handler({ question: "two", includeThinking: true }, () => {});
    assert.deepEqual(questions, ["one", "two"]);
    assert.deepEqual(first, { report: "report one", snapshotAt: "fixed", stopReason: "stop", usage });
    assert.deepEqual(thinkingFlags, [false, true]);
    assert.equal((second as any).report, "report two");
    assert.deepEqual(emitted, ["stage", "token"]);
  } finally {
    if (saved === undefined) delete globals[PEEK_GLOBAL_KEY];
    else globals[PEEK_GLOBAL_KEY] = saved;
  }
});

test("remote client forwards progress, closes connections, and does not send after cancellation", async () => {
  const saved = globals[MESH_GLOBAL_KEY];
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "peek-client-"));
  process.env.PI_CODING_AGENT_DIR = root;
  let closed = 0;
  let requestCount = 0;
  let abortDuringConnect: AbortController | undefined;
  let requestData: unknown;
  globals[MESH_GLOBAL_KEY] = {
    resolvePeer: async () => ({ name: "Peer", sessionId: "peer-session" }),
    connect: async () => {
      abortDuringConnect?.abort(new Error("cancelled during connect"));
      return {
      request: async (_type: string, data: unknown, options: any) => {
        requestCount++;
        requestData = data;
        options.onEmit("stage", { stage: "investigating" });
        return { report: "remote report", snapshotAt: "fixed", stopReason: "length" };
      },
      close: () => { closed++; },
      };
    },
  };
  try {
    let tool: any;
    register({ events: { on() {} }, on() {}, registerTool: (value: unknown) => { tool = value; } } as unknown as ExtensionAPI);
    const updates: unknown[] = [];
    const result = await tool.execute("id", { question: "focus", includeThinking: true }, undefined, (update: unknown) => updates.push(update), { cwd: root });
    assert.deepEqual(requestData, { question: "focus", includeThinking: true });
    assert.match(JSON.stringify(updates), /investigating/);
    assert.equal(result.content[0].text, "remote report");
    assert.equal(result.details.snapshotAt, "fixed");
    assert.match(result.content[1].text, /Output limit reached/);
    assert.equal(closed, 1);
    abortDuringConnect = new AbortController();
    await assert.rejects(tool.execute("cancelled", { question: "never send" }, abortDuringConnect.signal, undefined, { cwd: root }), /cancelled during connect/);
    assert.equal(requestCount, 1);
    assert.equal(closed, 2);
    await assert.rejects(tool.execute("already-cancelled", { question: "never resolve" }, abortDuringConnect.signal, undefined, { cwd: root }), /cancelled during connect/);
    assert.equal(closed, 2);
  } finally {
    if (saved === undefined) delete globals[MESH_GLOBAL_KEY];
    else globals[MESH_GLOBAL_KEY] = saved;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    rmSync(root, { recursive: true, force: true });
  }
});
