import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createInvestigation, type InvestigationDeps } from "./investigate.ts";
import { SessionSnapshot } from "./snapshot.ts";

const model: Model<Api> = {
  id: "fake", name: "Fake", api: "openai-completions", provider: "offline",
  baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
};
const makeSnapshot = () => new SessionSnapshot([
  { type: "message", id: "source", message: { role: "assistant", content: [
    { type: "text", text: "A recorded answer" }, { type: "thinking", thinking: "saved thinking evidence" },
  ] } },
] as unknown as SessionEntry[], "2026-01-01T00:00:00Z");
function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", api: model.api, model: model.id, provider: model.provider,
    content, stopReason, timestamp: 1,
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 } },
  };
}
const text = (value: string) => response([{ type: "text", text: value }]);
type Request = { context: Context; options: SimpleStreamOptions };
function fakeStream(messages: AssistantMessage[], requests: Request[]): InvestigationDeps["stream"] {
  return async (context, options) => {
    requests.push({ context: structuredClone(context), options });
    const message = messages.shift();
    assert.ok(message, "unexpected model request");
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    message.content.forEach((b, contentIndex) => {
      if (b.type === "text") stream.push({ type: "text_delta", contentIndex, delta: b.text, partial: message });
    });
    if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
    else stream.push({ type: "done", reason: message.stopReason as "stop", message });
    return stream;
  };
}

test("each question uses one tool-free request with a stable reference and complete prior reports", async () => {
  const requests: Request[] = [];
  const investigation = createInvestigation({ snapshot: makeSnapshot(), model, stream: fakeStream([text("first"), text("second")], requests) });
  let streamed = "";
  try {
    const first = await investigation.investigate("Question one", { onToken: delta => { streamed += delta; } });
    assert.equal(first.report, "first");
    assert.equal(streamed, first.report);
    assert.equal((await investigation.investigate("Question two")).report, "second");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.context.systemPrompt, requests[1]!.context.systemPrompt);
    assert.equal(requests[0]!.context.tools, undefined);
    assert.equal(requests[0]!.options.toolChoice, undefined);
    assert.equal(requests[0]!.options.maxTokens, model.maxTokens);
    assert.doesNotMatch(requests[0]!.context.systemPrompt!, /saved thinking evidence/);
    assert.equal(requests[1]!.context.messages.length, 3);
    assert.equal(requests[0]!.options.cacheRetention, "short");
    assert.deepEqual(first.usage, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100, cost: 0.1 });
  } finally { investigation.dispose(); }
});

test("thinking inclusion is explicit and fixed for the lifetime of the investigation", async () => {
  const requests: Request[] = [];
  const investigation = createInvestigation({ snapshot: makeSnapshot(), model, includeThinking: true, stream: fakeStream([text("first"), text("second")], requests) });
  try {
    await investigation.investigate("What does the saved thinking say?");
    await investigation.investigate("Explain it");
    assert.match(requests[0]!.context.systemPrompt!, /saved thinking evidence/);
    assert.equal(requests[0]!.context.systemPrompt, requests[1]!.context.systemPrompt);
    assert.equal(requests.length, 2);
  } finally { investigation.dispose(); }
});

test("large references, questions and reports pass through without local context guards or truncation", async () => {
  const source = `HEAD${"界".repeat(300_000)}TAIL`;
  const question = "question".repeat(30_000);
  const report = `  ${"report".repeat(30_000)}\n`;
  const snapshot = new SessionSnapshot([{ type: "message", id: "a", message: { role: "user", content: source } }] as unknown as SessionEntry[]);
  const requests: Request[] = [];
  const investigation = createInvestigation({ snapshot, model, stream: fakeStream([text(report)], requests) });
  try {
    const result = await investigation.investigate(question);
    assert.ok(requests[0]!.context.systemPrompt!.includes(source));
    assert.ok(JSON.stringify(requests[0]!.context.messages).includes(question));
    assert.equal(result.report, report);
    assert.equal(result.stopReason, "stop");
  } finally { investigation.dispose(); }
});

test("upstream context errors are classified without retrying or dropping prior successful turns", async () => {
  const requests: Request[] = [];
  const failure = response([], "error");
  failure.errorMessage = "prompt is too long: 200000 tokens > 128000 maximum";
  const investigation = createInvestigation({ snapshot: makeSnapshot(), model, stream: fakeStream([text("first"), failure, text("after")], requests) });
  try {
    await investigation.investigate("first");
    await assert.rejects(investigation.investigate("failed question"), { code: "context_overflow" });
    assert.equal(requests.length, 2);
    await investigation.investigate("follow-up");
    assert.equal(requests[2]!.context.messages.length, 3);
    assert.doesNotMatch(JSON.stringify(requests[2]!.context.messages), /failed question/);
    assert.equal(requests[0]!.context.systemPrompt, requests[2]!.context.systemPrompt);
  } finally { investigation.dispose(); }
});

test("context errors thrown during stream setup are also classified", async () => {
  let requests = 0;
  const investigation = createInvestigation({ snapshot: makeSnapshot(), model, stream: async () => {
    requests++;
    throw new Error("maximum context length is 128000 tokens");
  } });
  try {
    await assert.rejects(investigation.investigate("Question"), { code: "context_overflow" });
    assert.equal(requests, 1);
  } finally { investigation.dispose(); }
});

test("an upstream length stop preserves the exact partial report with separate metadata and no auto-continuation", async () => {
  const requests: Request[] = [];
  const partial = response([{ type: "text", text: "  partial report\n" }], "length");
  const investigation = createInvestigation({ snapshot: makeSnapshot(), model, stream: fakeStream([partial, text("continued")], requests) });
  try {
    const result = await investigation.investigate("first");
    assert.equal(result.stopReason, "length");
    assert.equal(result.report, "  partial report\n");
    assert.equal(requests.length, 1);
    await investigation.investigate("continue");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]!.context.messages[1], partial);
  } finally { investigation.dispose(); }
});

test("unexpected tools and terminal states fail without executing or looping", async () => {
  const toolResponse = response([{ type: "toolCall", id: "call", name: "read_record", arguments: { id: "M1" } }], "toolUse");
  for (const message of [toolResponse, ...(["error", "aborted", "deferred", "toolUse"] as const).map(reason => response([], reason))]) {
    const requests: Request[] = [];
    const investigation = createInvestigation({ snapshot: makeSnapshot(), model, stream: fakeStream([message], requests) });
    try {
      await assert.rejects(investigation.investigate("Question"), /response|stop reason/);
      assert.equal(requests.length, 1);
    } finally { investigation.dispose(); }
  }
});

test("dispose cancels in-flight work and rejects further questions", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined;
  const investigation = createInvestigation({ snapshot: makeSnapshot(), model, stream: async (_context, options) => {
    signal = options.signal;
    started();
    return createAssistantMessageEventStream();
  } });
  const pending = investigation.investigate("Question");
  await ready;
  await assert.rejects(investigation.investigate("Concurrent"), /already running/);
  investigation.dispose();
  investigation.dispose();
  await assert.rejects(pending, /investigation closed/);
  assert.equal(signal?.aborted, true);
  await assert.rejects(investigation.investigate("Later"), /closed/);
});

test("callback failures abort the transport and leave history uncommitted", async () => {
  let signal: AbortSignal | undefined;
  const requests: Request[] = [];
  const stream = fakeStream([text("partial"), text("retry")], requests);
  const investigation = createInvestigation({ snapshot: makeSnapshot(), model, stream: async (context, options) => {
    signal = options.signal;
    return stream(context, options);
  } });
  try {
    await assert.rejects(investigation.investigate("failed", { onToken: () => { throw new Error("consumer failed"); } }), /consumer failed/);
    assert.equal(signal?.aborted, true);
    await investigation.investigate("retry");
    assert.equal(requests[1]!.context.messages.length, 1);
  } finally { investigation.dispose(); }
});

test("iterator failures abort the transport", async () => {
  let signal: AbortSignal | undefined;
  const investigation = createInvestigation({ snapshot: makeSnapshot(), model, stream: async (_context, options) => {
    signal = options.signal;
    const stream = createAssistantMessageEventStream();
    stream[Symbol.asyncIterator] = () => ({ next: async () => { throw new Error("iterator failed"); } });
    return stream;
  } });
  try {
    await assert.rejects(investigation.investigate("Question"), /iterator failed/);
    assert.equal(signal?.aborted, true);
  } finally { investigation.dispose(); }
});

test("independent investigations preserve the system prefix across different capture times", async () => {
  const requests: Request[] = [];
  const investigations = ["2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"].map(capturedAt => createInvestigation({
    snapshot: new SessionSnapshot([], capturedAt), model, stream: fakeStream([text("report")], requests),
  }));
  try {
    for (const investigation of investigations) await investigation.investigate("Question");
    assert.equal(requests[0]!.context.systemPrompt, requests[1]!.context.systemPrompt);
    assert.notDeepEqual(requests[0]!.context.messages, requests[1]!.context.messages);
  } finally { investigations.forEach(c => c.dispose()); }
});

test("the deadline also bounds stalled stream setup", async () => {
  const investigation = createInvestigation({ snapshot: makeSnapshot(), model, config: { timeoutMs: 15 }, stream: () => new Promise(() => {}) });
  try { await assert.rejects(investigation.investigate("Question"), /timed out/); }
  finally { investigation.dispose(); }
});
