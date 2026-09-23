import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InvestigateOptions, PeekReferenceOptions } from "@d3ara1n/pi-peek";
import { PROGRESS_THROTTLE_MS } from "./tool.ts";
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
      return { report: `report ${questions.length}`, snapshotAt: "fixed", stopReason: "stop", usage };
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
    assert.equal(questions.length, 2);
    assert.match(questions[0]!, /Question \(JSON string\):\n"one"/);
    assert.match(questions[0]!, /<peek-summary>.*<\/peek-summary>\n<peek-report>.*<\/peek-report>/);
    assert.match(questions[0]!, /The summary is only for compact display/);
    assert.match(questions[1]!, /Question \(JSON string\):\n"two"/);
    assert.deepEqual(first, { report: "report 1", snapshotAt: "fixed", stopReason: "stop", usage });
    assert.deepEqual(thinkingFlags, [false, true]);
    assert.equal((second as any).report, "report 2");
    assert.deepEqual(emitted, ["stage", "token"]);
  } finally {
    if (saved === undefined) delete globals[PEEK_GLOBAL_KEY];
    else globals[PEEK_GLOBAL_KEY] = saved;
  }
});

test("remote handler extracts a complete envelope without limiting the summary and preserves malformed output", async () => {
  const saved = globals[PEEK_GLOBAL_KEY];
  const longSummary = "detail ".repeat(100);
  const cases = [
    { raw: `<peek-summary>${longSummary}</peek-summary>\n<peek-report>Full report\nSecond line</peek-report>`, expected: { summary: longSummary, report: "Full report\nSecond line" } },
    { raw: "<peek-summary>First line\nsecond line</peek-summary>\r\n<peek-report>Details</peek-report>\r\n", expected: { summary: "First line\nsecond line", report: "Details" } },
    { raw: "<peek-summary>Code details</peek-summary>\n<peek-report>Markdown & <code>example</code>\n</peek-report>", expected: { summary: "Code details", report: "Markdown & <code>example</code>\n" } },
    { raw: "<peek-summary>Quoted marker</peek-summary>\n<peek-report>Literal </peek-report> in the text\nEnd</peek-report>", expected: { summary: "Quoted marker", report: "Literal </peek-report> in the text\nEnd" } },
    { raw: "# Summary\nFull report", expected: { report: "# Summary\nFull report" } },
    { raw: "<peek-summary>Partial</peek-summary>\n<peek-report>Incomplete", expected: { report: "<peek-summary>Partial</peek-summary>\n<peek-report>Incomplete" } },
    { raw: "<peek-summary>Done</peek-summary>\n<peek-report>Body</peek_report>", expected: { report: "<peek-summary>Done</peek-summary>\n<peek-report>Body</peek_report>" } },
    { raw: "<peek-summary> </peek-summary>\n<peek-report>Details</peek-report>", expected: { report: "<peek-summary> </peek-summary>\n<peek-report>Details</peek-report>" } },
  ];
  let index = 0;
  globals[PEEK_GLOBAL_KEY] = {
    async investigate() { return { report: cases[index++]!.raw, snapshotAt: "fixed", stopReason: "stop" }; },
  };
  try {
    let ready!: (mesh: unknown) => void;
    let handler!: (data: unknown, emit: (type: string, data?: unknown) => void) => Promise<unknown>;
    register({
      events: { on: (_name: string, fn: typeof ready) => { ready = fn; } },
      on() {}, registerTool() {},
    } as unknown as ExtensionAPI);
    ready({ serve: (_type: string, fn: typeof handler) => { handler = fn; } });
    for (const { expected } of cases) {
      assert.deepEqual(await handler({ question: "What happened?" }, () => {}), { ...expected, snapshotAt: "fixed", stopReason: "stop", usage: undefined });
    }
    assert.equal(index, cases.length);
    await assert.rejects(handler({ question: "  " }, () => {}), /question must not be empty/);
    assert.equal(index, cases.length);
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
        await new Promise(resolve => setTimeout(resolve, PROGRESS_THROTTLE_MS + 40));
        options.onEmit("token", { delta: "<peek-summary>sum</peek-summary>\n<peek-report>remote report" });
        await new Promise(resolve => setTimeout(resolve, PROGRESS_THROTTLE_MS + 40));
        options.onEmit("token", { delta: "\nmore detail</peek-report>" });
        options.onEmit("stage", { stage: "done" });
        return { report: "remote report\nmore detail", summary: "Detailed result ".repeat(40), snapshotAt: "fixed", stopReason: "length" };
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
    assert.deepEqual(updates[0], { content: [], details: { stage: "connecting", chars: 0 } });
    assert.deepEqual(updates[1], { content: [], details: { stage: "investigating", chars: 0 } });
    // Each token push lands after the throttle window; accumulation carries across pushes.
    assert.equal(updates.length, 5);
    assert.deepEqual(updates[3], { content: [{ type: "text", text: "remote report\nmore detail" }], details: { stage: "investigating", chars: "remote report\nmore detail".length } });
    assert.equal((updates[2] as any).content[0].text, "remote report");
    const partial = updates[4] as any;
    assert.equal(partial.details.stage, "done");
    assert.equal(partial.details.chars, "remote report\nmore detail".length);
    assert.equal(partial.content[0].text, "remote report\nmore detail");
    assert.equal(result.content[0].text, "remote report\nmore detail");
    assert.equal(result.details.snapshotAt, "fixed");
    assert.equal(result.details.summary, "Detailed result ".repeat(40));
    assert.match(result.content[1].text, /Output limit reached/);
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const collapsed = tool.renderResult(result, { expanded: false }, theme, { isError: false, isPartial: false }).render(35)[0];
    assert.match(collapsed, /^✓ Detailed result/);
    assert.match(collapsed, /…/);
    assert.ok(collapsed.length < result.details.summary.length);
    const expanded = tool.renderResult(result, { expanded: true }, theme, { args: { question: "focus" }, isError: false }).render(200).join("\n");
    assert.match(expanded, /focus/);
    assert.match(expanded, /remote report/);
    assert.match(expanded, /more detail/);
    assert.doesNotMatch(expanded, /Detailed result/);
    const fallback = tool.renderResult({ content: [{ type: "text", text: "First report line\nmore detail" }], details: {} }, { expanded: false }, theme, { isError: false }).render(200)[0];
    assert.match(fallback, /^✓ First report line/);
    const multiline = tool.renderResult({ content: [{ type: "text", text: "Full report" }], details: { summary: "First\nsecond" } }, { expanded: false }, theme, { isError: false }).render(200)[0];
    assert.match(multiline, /^✓ First second/);
    const partialCollapsed = tool.renderResult(partial, { expanded: false }, theme, { isError: false, isPartial: true }).render(60)[0];
    assert.match(partialCollapsed, new RegExp(`^⏳ ${partial.details.stage} · ${partial.details.chars} chars`));
    const partialExpanded = tool.renderResult(partial, { expanded: true }, theme, { args: { question: "focus" }, isPartial: true }).render(200).map((l: string) => l.trimEnd()).join("\n");
    assert.match(partialExpanded, /focus/);
    assert.match(partialExpanded, /remote report/);
    assert.match(partialExpanded, /more detail/);
    assert.doesNotMatch(partialExpanded, /peek-|investigating|chars/);
    const connecting = tool.renderResult(updates[0], { expanded: true }, theme, { args: { question: "focus" }, isPartial: true }).render(200).map((l: string) => l.trimEnd()).join("\n");
    assert.match(connecting, /focus/);
    assert.match(connecting, /…/);
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
