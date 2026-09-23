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
  const metrics = { requests: 3, toolCalls: 2, elapsedMs: 1000 };
  globals[PEEK_GLOBAL_KEY] = {
    async investigate(question: string, opts: InvestigateOptions & PeekReferenceOptions) {
      questions.push(question);
      thinkingFlags.push(opts.includeThinking);
      opts.onStage?.("investigating");
      opts.onProgress?.({
        stage: "thinking",
        phase: "investigation",
        round: 1,
        maxRounds: 6,
        request: 1,
        toolCalls: 0,
        model: "fake/reasoner",
        chars: 0,
        elapsedMs: 10,
      });
      opts.onReset?.();
      opts.onToken?.(`report ${questions.length}`);
      return {
        report: `report ${questions.length}`,
        snapshotAt: "fixed",
        stopReason: "stop",
        usage,
        metrics,
      };
    },
  };
  try {
    let ready!: (mesh: unknown) => void;
    let handler!: (data: unknown, emit: (type: string, data?: unknown) => void) => Promise<unknown>;
    register({
      events: {
        on: (_name: string, fn: typeof ready) => {
          ready = fn;
        },
      },
      on() {},
      registerTool() {},
    } as unknown as ExtensionAPI);
    ready({
      serve: (_type: string, fn: typeof handler) => {
        handler = fn;
      },
    });
    const emitted: { type: string; data?: unknown }[] = [];
    const first = await handler({ question: "one" }, (type, data) => {
      emitted.push({ type, data });
    });
    const second = await handler({ question: "two", includeThinking: true }, () => {});
    assert.deepEqual(questions, ["one", "two"]);
    assert.deepEqual(first, {
      report: "report 1",
      summary: "report 1",
      reportMode: "fallback",
      snapshotAt: "fixed",
      stopReason: "stop",
      usage,
      metrics,
    });
    assert.deepEqual(thinkingFlags, [false, true]);
    assert.equal((second as any).report, "report 2");
    assert.deepEqual(
      emitted.map((item) => item.type),
      ["stage", "progress", "report_reset", "token"],
    );
    assert.deepEqual(emitted.at(-1)?.data, { delta: "report 1", format: "report" });
  } finally {
    if (saved === undefined) delete globals[PEEK_GLOBAL_KEY];
    else globals[PEEK_GLOBAL_KEY] = saved;
  }
});

test("remote handler forwards already parsed report bodies without parsing them again", async () => {
  const saved = globals[PEEK_GLOBAL_KEY];
  const cases = [
    { report: "Full report\nSecond line", summary: "detail ".repeat(100), reportMode: "tagged" },
    {
      report: "A literal <peek-report> marker inside a report",
      summary: "Literal marker",
      reportMode: "tagged",
    },
    { report: "Plain fallback", summary: "Plain fallback", reportMode: "fallback" },
  ];
  let index = 0;
  globals[PEEK_GLOBAL_KEY] = {
    async investigate() {
      return { ...cases[index++], snapshotAt: "fixed", stopReason: "stop" };
    },
  };
  try {
    let ready!: (mesh: unknown) => void;
    let handler!: (data: unknown, emit: (type: string, data?: unknown) => void) => Promise<unknown>;
    register({
      events: {
        on: (_name: string, fn: typeof ready) => {
          ready = fn;
        },
      },
      on() {},
      registerTool() {},
    } as unknown as ExtensionAPI);
    ready({
      serve: (_type: string, fn: typeof handler) => {
        handler = fn;
      },
    });
    for (const expected of cases) {
      assert.deepEqual(await handler({ question: "What happened?" }, () => {}), {
        ...expected,
        snapshotAt: "fixed",
        stopReason: "stop",
        usage: undefined,
      });
    }
    assert.equal(index, cases.length);
    await assert.rejects(
      handler({ question: "  " }, () => {}),
      /question must not be empty/,
    );
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
          await new Promise((resolve) => setTimeout(resolve, PROGRESS_THROTTLE_MS + 40));
          options.onEmit("token", {
            delta:
              "I now have sufficient evidence. <peek-summary>sum</peek-summary> ignored junction <peek-report>remote report",
          });
          await new Promise((resolve) => setTimeout(resolve, PROGRESS_THROTTLE_MS + 40));
          options.onEmit("token", { delta: "\nmore detail</peek-report>" });
          options.onEmit("stage", { stage: "done" });
          return {
            report:
              "preamble<peek-summary>sum</peek-summary><peek-report>remote report\nmore detail</peek-report>tail",
            summary: "Detailed result ".repeat(40),
            snapshotAt: "fixed",
            stopReason: "length",
          };
        },
        close: () => {
          closed++;
        },
      };
    },
  };
  try {
    let tool: any;
    register({
      events: { on() {} },
      on() {},
      registerTool: (value: unknown) => {
        tool = value;
      },
    } as unknown as ExtensionAPI);
    const updates: unknown[] = [];
    const result = await tool.execute(
      "id",
      { question: "focus", includeThinking: true },
      undefined,
      (update: unknown) => updates.push(update),
      { cwd: root },
    );
    assert.deepEqual(requestData, { question: "focus", includeThinking: true });
    assert.match(JSON.stringify(updates), /investigating/);
    assert.deepEqual(updates[0], { content: [], details: { stage: "connecting", chars: 0 } });
    assert.deepEqual(updates[1], { content: [], details: { stage: "investigating", chars: 0 } });
    // Each token push lands after the throttle window; accumulation carries across pushes.
    assert.ok(updates.length >= 5);
    assert.deepEqual(updates[3], {
      content: [{ type: "text", text: "remote report\nmore detail" }],
      details: { stage: "outputting", phase: "report", chars: "remote report\nmore detail".length },
    });
    assert.equal((updates[2] as any).content[0].text, "remote report");
    const partial = updates.at(-1) as any;
    assert.equal(partial.details.stage, "done");
    assert.equal(partial.details.chars, "remote report\nmore detail".length);
    assert.equal(partial.content[0].text, "remote report\nmore detail");
    assert.equal(result.content[0].text, "remote report\nmore detail");
    assert.equal(result.details.snapshotAt, "fixed");
    assert.equal(result.details.summary, "Detailed result ".repeat(40));
    assert.match(result.content[1].text, /Output limit reached/);
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const collapsed = tool
      .renderResult(result, { expanded: false }, theme, { isError: false, isPartial: false })
      .render(35)[0];
    assert.match(collapsed, /^✓ Detailed result/);
    assert.match(collapsed, /…/);
    assert.ok(collapsed.length < result.details.summary.length);
    const expanded = tool
      .renderResult(result, { expanded: true }, theme, {
        args: { question: "focus" },
        isError: false,
      })
      .render(200)
      .join("\n");
    assert.match(expanded, /focus/);
    assert.match(expanded, /remote report/);
    assert.match(expanded, /more detail/);
    assert.doesNotMatch(expanded, /Detailed result/);
    const fallback = tool
      .renderResult(
        { content: [{ type: "text", text: "First report line\nmore detail" }], details: {} },
        { expanded: false },
        theme,
        { isError: false },
      )
      .render(200)[0];
    assert.match(fallback, /^✓ First report line/);
    const multiline = tool
      .renderResult(
        { content: [{ type: "text", text: "Full report" }], details: { summary: "First\nsecond" } },
        { expanded: false },
        theme,
        { isError: false },
      )
      .render(200)[0];
    assert.match(multiline, /^✓ First second/);
    const partialCollapsed = tool
      .renderResult(partial, { expanded: false }, theme, { isError: false, isPartial: true })
      .render(60)[0];
    assert.match(
      partialCollapsed,
      new RegExp(`^⏳ ${partial.details.stage} · ${partial.details.chars} chars`),
    );
    const partialExpanded = tool
      .renderResult(partial, { expanded: true }, theme, {
        args: { question: "focus" },
        isPartial: true,
      })
      .render(200)
      .map((l: string) => l.trimEnd())
      .join("\n");
    assert.match(partialExpanded, /focus/);
    assert.match(partialExpanded, /remote report/);
    assert.match(partialExpanded, /more detail/);
    assert.doesNotMatch(partialExpanded, /peek-|investigating|chars/);
    const connecting = tool
      .renderResult(updates[0], { expanded: true }, theme, {
        args: { question: "focus" },
        isPartial: true,
      })
      .render(200)
      .map((l: string) => l.trimEnd())
      .join("\n");
    assert.match(connecting, /focus/);
    assert.match(connecting, /…/);
    assert.equal(closed, 1);
    abortDuringConnect = new AbortController();
    await assert.rejects(
      tool.execute("cancelled", { question: "never send" }, abortDuringConnect.signal, undefined, {
        cwd: root,
      }),
      /cancelled during connect/,
    );
    assert.equal(requestCount, 1);
    assert.equal(closed, 2);
    await assert.rejects(
      tool.execute(
        "already-cancelled",
        { question: "never resolve" },
        abortDuringConnect.signal,
        undefined,
        { cwd: root },
      ),
      /cancelled during connect/,
    );
    assert.equal(closed, 2);
  } finally {
    if (saved === undefined) delete globals[MESH_GLOBAL_KEY];
    else globals[MESH_GLOBAL_KEY] = saved;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("rich progress drives collapsed activity while expanded output waits, then flushes trailing report text", async () => {
  const saved = globals[MESH_GLOBAL_KEY];
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "peek-progress-"));
  process.env.PI_CODING_AGENT_DIR = root;
  const updates: any[] = [];
  const metrics = { requests: 3, toolCalls: 2, elapsedMs: 500 };
  let tool: any;
  let closed = 0;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const screen = (expanded: boolean) =>
    tool
      .renderResult(updates.at(-1), { expanded }, theme, {
        args: { question: "focus" },
        isPartial: true,
      })
      .render(100)
      .join("\n");
  globals[MESH_GLOBAL_KEY] = {
    resolvePeer: async () => ({ name: "Peer", sessionId: "peer-session" }),
    connect: async () => ({
      request: async (_type: string, _data: unknown, options: any) => {
        options.onEmit("token", { delta: "provisional", format: "report" });
        assert.equal(updates.at(-1).content[0].text, "provisional");
        options.onEmit("report_reset", {});
        assert.deepEqual(updates.at(-1).content, []);
        for (const stage of ["thinking", "searching", "reading", "outputting"]) {
          options.onEmit("progress", {
            stage,
            phase: "investigation",
            round: 2,
            maxRounds: 6,
            request: 2,
            toolCalls: 1,
            model: "fake/reasoner",
            chars: 0,
            elapsedMs: 20,
            thinking: "DO_NOT_FORWARD",
          });
          assert.match(screen(false), new RegExp(`${stage}…`));
          assert.match(screen(true), /…/);
          assert.doesNotMatch(screen(true), /thinking|searching|reading|outputting|chars/);
          assert.equal(updates.at(-1).details.model, "fake/reasoner");
          assert.deepEqual(updates.at(-1).content, []);
        }
        options.onEmit("progress", { stage: "outputting", phase: "report", chars: 99 });
        options.onEmit("token", {
          delta: "streamed text",
          format: "report",
        });
        await new Promise((resolve) => setTimeout(resolve, PROGRESS_THROTTLE_MS + 40));
        // No second token or completion event was needed to flush the short first chunk.
        assert.equal(updates.at(-1).content[0].text, "streamed text");
        assert.equal(updates.at(-1).details.chars, "streamed text".length);
        assert.match(screen(false), /outputting… · 13 chars/);
        assert.match(screen(true), /streamed/);
        assert.doesNotMatch(screen(true), /outputting|peek-report|Short/);
        options.onEmit("progress", { stage: "thinking", phase: "report" });
        assert.equal(updates.at(-1).details.stage, "outputting");
        options.onEmit("token", { delta: " report", format: "report" });
        return { report: "streamed text report", summary: "Short", reportMode: "tagged", metrics };
      },
      close() {
        closed++;
      },
    }),
  };
  try {
    register({
      events: { on() {} },
      on() {},
      registerTool: (value: unknown) => {
        tool = value;
      },
    } as unknown as ExtensionAPI);
    const result = await tool.execute(
      "id",
      { question: "focus" },
      undefined,
      (update: unknown) => updates.push(update),
      { cwd: root },
    );
    assert.equal(result.details.metrics, metrics);
    assert.equal(updates.at(-1).content[0].text, "streamed text report");
    assert.doesNotMatch(JSON.stringify(updates), /DO_NOT_FORWARD/);
    assert.equal(closed, 1);
  } finally {
    if (saved === undefined) delete globals[MESH_GLOBAL_KEY];
    else globals[MESH_GLOBAL_KEY] = saved;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    rmSync(root, { recursive: true, force: true });
  }
});
