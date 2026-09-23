import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Api,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createInvestigation } from "./investigate.ts";
import { SessionSnapshot } from "./snapshot.ts";
import { estimateRequestTokens } from "./budget.ts";

const model = {
  id: "investigator",
  provider: "offline",
  api: "openai-completions",
  contextWindow: 128000,
  maxTokens: 32000,
} as Model<Api>;
function snapshot(text = "saved main conversation", capturedAt = "2026-01-01T00:00:00Z") {
  return new SessionSnapshot([{ role: "user", content: text, timestamp: 1 }], { capturedAt });
}
function response(
  text = "report",
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    timestamp: 2,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
  };
}
function call(
  name: string,
  args: Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"],
  id = "call",
) {
  const message = response("Let me inspect the evidence.", "toolUse");
  message.content.push({ type: "toolCall", name, arguments: args, id });
  return message;
}
function streamOf(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  for (const block of message.content)
    if (block.type === "text")
      stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: message });
  if (message.stopReason === "error" || message.stopReason === "aborted")
    stream.push({ type: "error", reason: message.stopReason, error: message });
  else
    stream.push({
      type: "done",
      reason: message.stopReason as "stop" | "length" | "toolUse",
      message,
    });
  return stream;
}
function textOf(messages: Message[]) {
  return JSON.stringify(messages);
}

test("search/read/report loop retains call pairing, hides intermediate text and accumulates usage", async () => {
  const records = new SessionSnapshot([
    { role: "user", content: "What failed?", timestamp: 1 },
    {
      ...response(),
      content: [
        { type: "toolCall", id: "source", name: "bash", arguments: { command: "node --test" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "source",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: "distinctive-error: expected 2, received 3" }],
      timestamp: 3,
    },
  ]);
  const requests: Context[] = [];
  const stages: string[] = [];
  const visible: string[] = [];
  const queue = [
    call("search_session", { query: "distinctive-error" }, "search1"),
    call("read_session", { ids: ["T1"] }, "read1"),
    response("The test expected 2 but received 3 (T1)."),
  ];
  const investigation = createInvestigation({
    snapshot: records,
    model,
    stream: async (context, options) => {
      requests.push(structuredClone(context));
      assert.equal(options.maxTokens, 8192);
      assert.equal(options.cacheRetention, "short");
      return streamOf(queue.shift()!);
    },
  });
  const result = await investigation.investigate("Explain the failure.", {
    onToken: (text) => visible.push(text),
    onStage: (stage) => stages.push(stage),
  });
  assert.equal(requests.length, 3);
  assert.doesNotMatch(requests[0]!.systemPrompt!, /distinctive-error/);
  assert.deepEqual(
    requests[0]!.tools?.map((t) => t.name),
    ["search_session", "read_session"],
  );
  assert.match(textOf(requests[1]!.messages), /distinctive-error/);
  assert.match(textOf(requests[2]!.messages), /node --test/);
  for (const context of requests.slice(1)) {
    const calls = context.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content.filter((b) => b.type === "toolCall"));
    const results = context.messages.filter((m) => m.role === "toolResult");
    assert.deepEqual(
      results.map((m) => m.toolCallId),
      calls.map((c) => c.id),
    );
  }
  assert.deepEqual(visible, [result.report]);
  assert.doesNotMatch(visible.join(""), /Let me inspect/);
  assert.ok(stages.includes("searching") && stages.includes("reading"));
  assert.equal(stages.at(-1), "done");
  assert.deepEqual(result.usage, {
    input: 30,
    output: 15,
    cacheRead: 6,
    cacheWrite: 3,
    total: 54,
    cost: 0.09,
  });
  investigation.dispose();
});

test("direct answers need one request; follow-ups retain reports but not retrieval scratch history", async () => {
  const requests: Context[] = [];
  const queue = [
    call("read_session", { ids: ["U1"] }),
    response("first report"),
    response("follow-up report"),
  ];
  const investigation = createInvestigation({
    snapshot: snapshot(),
    model,
    stream: async (context) => {
      requests.push(structuredClone(context));
      return streamOf(queue.shift()!);
    },
  });
  await investigation.investigate("first question");
  await investigation.investigate("second question");
  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.systemPrompt, requests[2]!.systemPrompt);
  assert.equal(requests[2]!.messages.length, 3);
  assert.match(textOf(requests[2]!.messages), /first question|first report|second question/);
  assert.doesNotMatch(textOf(requests[2]!.messages), /toolResult|Let me inspect/);
  investigation.dispose();
});

test("tool mistakes are recoverable and the last round is tool-free", async () => {
  const requests: Context[] = [];
  const choices: SimpleStreamOptions["toolChoice"][] = [];
  const stages: string[] = [];
  const investigation = createInvestigation({
    snapshot: snapshot(),
    model,
    config: { maxRounds: 2 },
    stream: async (context, options) => {
      choices.push(options.toolChoice);
      requests.push(structuredClone(context));
      return streamOf(
        requests.length === 1
          ? call("bash", { command: "touch forbidden" })
          : response("The requested evidence is unavailable."),
      );
    },
  });
  await investigation.investigate("question", { onStage: (stage) => stages.push(stage) });
  assert.deepEqual(choices, [undefined, "none"]);
  assert.match(
    textOf(requests[1]!.messages),
    /Unexpected tool argument|Unknown investigation tool/,
  );
  assert.match(textOf(requests[1]!.messages), /tool calls are disabled/);
  assert.ok(stages.includes("outputting"));
  investigation.dispose();
});

test("input budgets cover huge source text and retrieved results on a smaller model", async () => {
  const smallModel = { ...model, contextWindow: 8000, maxTokens: 2000 };
  const choices: SimpleStreamOptions["toolChoice"][] = [];
  const requests: Context[] = [];
  const investigation = createInvestigation({
    snapshot: snapshot("界".repeat(100000)),
    model: smallModel,
    stream: async (context, options) => {
      choices.push(options.toolChoice);
      requests.push(structuredClone(context));
      return streamOf(
        requests.length === 1
          ? call("read_session", { ids: ["U1"], limit: 12000 })
          : response("Only a bounded excerpt was inspected."),
      );
    },
  });
  await investigation.investigate("What was saved?");
  const budget = (8000 - 1000) * 0.8;
  assert.ok(requests.every((context) => estimateRequestTokens(context) <= budget));
  assert.equal(choices[1], "none");
  assert.match(textOf(requests[1]!.messages), /tool calls are disabled/);
  assert.match(textOf(requests[1]!.messages), /abbreviated|omitted/);
  investigation.dispose();
});

test("provider overflow shrinks requests with bounded retries; a failed question does not enter history", async () => {
  const requests: Context[] = [];
  let fail = true;
  const overflow = response("", "error");
  overflow.errorMessage = "prompt is too long: 200000 tokens > 128000 maximum";
  const investigation = createInvestigation({
    snapshot: new SessionSnapshot(
      Array.from({ length: 40 }, (_, timestamp) => ({
        role: "user" as const,
        content: "x".repeat(3000),
        timestamp,
      })),
    ),
    model,
    stream: async (context) => {
      requests.push(structuredClone(context));
      return streamOf(fail ? overflow : response("success"));
    },
  });
  await assert.rejects(
    investigation.investigate("failed question"),
    (error: any) => error.code === "context_overflow",
  );
  assert.equal(requests.length, 3);
  assert.ok(estimateRequestTokens(requests[1]!) < estimateRequestTokens(requests[0]!));
  assert.ok(estimateRequestTokens(requests[2]!) < estimateRequestTokens(requests[1]!));
  fail = false;
  await investigation.investigate("new question");
  assert.doesNotMatch(textOf(requests.at(-1)!.messages), /failed question/);
  assert.equal(requests.at(-1)!.messages.length, 1);
  investigation.dispose();
});

test("overflow retry can recover without rerunning retrieval or leaking failed text", async () => {
  const smallModel = { ...model, contextWindow: 12000 };
  const requests: Context[] = [];
  const overflow = response("rejected text", "error");
  overflow.errorMessage = "maximum context length exceeded";
  const queue = [call("read_session", { ids: ["U1"] }), overflow, response("recovered")];
  const visible: string[] = [];
  const investigation = createInvestigation({
    snapshot: snapshot("a".repeat(10000)),
    model: smallModel,
    stream: async (context) => {
      requests.push(structuredClone(context));
      return streamOf(queue.shift()!);
    },
  });
  const result = await investigation.investigate("question", {
    onToken: (delta) => visible.push(delta),
  });
  assert.equal(result.report, "recovered");
  assert.deepEqual(visible, ["recovered"]);
  assert.ok(estimateRequestTokens(requests[2]!) < estimateRequestTokens(requests[1]!));
  assert.equal(result.usage.total, 54);
  investigation.dispose();
});

test("output-limited final reports remain verbatim and empty reports are rejected", async () => {
  const queue = [response("partial report", "length"), response("", "stop")];
  const investigation = createInvestigation({
    snapshot: snapshot(),
    model,
    config: { maxRounds: 1 },
    stream: async () => streamOf(queue.shift()!),
  });
  const result = await investigation.investigate("question");
  assert.equal(result.report, "partial report");
  assert.equal(result.stopReason, "length");
  await assert.rejects(investigation.investigate("empty"), /empty report/);
  investigation.dispose();
});

test("disposal, timeout and external cancellation interrupt pending transport setup", async () => {
  for (const action of ["dispose", "timeout", "cancel"] as const) {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const external = new AbortController();
    const investigation = createInvestigation({
      snapshot: snapshot(),
      model,
      config: { timeoutMs: action === "timeout" ? 20 : 1000 },
      stream: async (_context, options) => {
        signal = options.signal;
        started();
        return new Promise(() => {});
      },
    });
    const pending = investigation.investigate("question", { signal: external.signal });
    await ready;
    await assert.rejects(investigation.investigate("concurrent"), /already running/);
    if (action === "dispose") investigation.dispose();
    if (action === "cancel") external.abort(new Error("external cancellation"));
    await assert.rejects(pending, /closed|timed out|external cancellation/);
    assert.equal(signal?.aborted, true);
    investigation.dispose();
    investigation.dispose();
    await assert.rejects(investigation.investigate("closed"), /closed/);
  }
});

test("callback failures abort transport and leave successful history unchanged", async () => {
  const requests: Context[] = [];
  let signal: AbortSignal | undefined;
  const investigation = createInvestigation({
    snapshot: snapshot(),
    model,
    stream: async (context, options: SimpleStreamOptions) => {
      requests.push(structuredClone(context));
      signal = options.signal;
      return streamOf(response("final report"));
    },
  });
  await assert.rejects(
    investigation.investigate("failed", {
      onToken: () => {
        throw new Error("consumer failed");
      },
    }),
    /consumer failed/,
  );
  assert.equal(signal?.aborted, true);
  await investigation.investigate("next");
  assert.equal(requests[1]!.messages.length, 1);
  investigation.dispose();
});

test("snapshot timestamps stay outside the reusable system prefix", async () => {
  const contexts: Context[] = [];
  for (const capturedAt of ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]) {
    const investigation = createInvestigation({
      snapshot: snapshot("same saved text", capturedAt),
      model,
      stream: async (context) => {
        contexts.push(context);
        return streamOf(response());
      },
    });
    await investigation.investigate("question");
    investigation.dispose();
  }
  assert.equal(contexts[0]!.systemPrompt, contexts[1]!.systemPrompt);
  assert.notEqual(textOf(contexts[0]!.messages), textOf(contexts[1]!.messages));
});

test("token rate limits are not retried or mislabeled as context overflow", async () => {
  for (const thrown of [false, true]) {
    let requests = 0;
    const investigation = createInvestigation({
      snapshot: snapshot(),
      model,
      stream: async () => {
        requests++;
        const error = "rate limit: too many tokens";
        if (thrown) throw new Error(error);
        const failure = response("", "error");
        failure.errorMessage = error;
        return streamOf(failure);
      },
    });
    await assert.rejects(investigation.investigate("question"), (error: any) => {
      assert.equal(error.message, "rate limit: too many tokens");
      assert.notEqual(error.code, "context_overflow");
      return true;
    });
    assert.equal(requests, 1);
    investigation.dispose();
  }
});

test("an irreducibly large question fails locally without calling the provider", async () => {
  let requests = 0;
  const investigation = createInvestigation({
    snapshot: snapshot(),
    model: { ...model, contextWindow: 8000 },
    stream: async () => {
      requests++;
      return streamOf(response());
    },
  });
  await assert.rejects(
    investigation.investigate("question ".repeat(10000)),
    (error: any) => error.code === "context_overflow",
  );
  assert.equal(requests, 0);
  investigation.dispose();
});

test("tagged report text streams in the same model request while preamble and summary stay hidden", async () => {
  const requests: Context[] = [];
  const chunks: string[] = [];
  const progress: import("./types.ts").InvestigateProgress[] = [];
  const output = createAssistantMessageEventStream();
  const investigation = createInvestigation({
    snapshot: snapshot(),
    model,
    stream: async (context, options) => {
      requests.push(structuredClone(context));
      assert.equal(options.toolChoice, undefined);
      return output;
    },
  });
  const pending = investigation.investigate("question", {
    onToken: (text) => chunks.push(text),
    onProgress: (value) => progress.push(value),
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0]!.tools?.map((tool) => tool.name),
      ["search_session", "read_session"],
    );
    const prefix =
      "I now have sufficient evidence. <peek-summary>Short finding</peek-summary> between <peek-report>";
    const raw = prefix + "# Report\nEvidence.</peek-report> tail";
    const message = response(raw);
    message.content.unshift({ type: "thinking", thinking: "PRIVATE_REASONING" });
    output.push({ type: "start", partial: message });
    output.push({ type: "thinking_start", contentIndex: 0, partial: message });
    output.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "PRIVATE_REASONING",
      partial: message,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(progress.at(-1)?.stage, "thinking");
    assert.deepEqual(chunks, []);
    output.push({ type: "text_start", contentIndex: 1, partial: message });
    output.push({ type: "text_delta", contentIndex: 1, delta: prefix, partial: message });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(progress.at(-1)?.stage, "outputting");
    assert.equal(progress.at(-1)?.chars, 0);
    assert.deepEqual(chunks, []);
    output.push({ type: "text_delta", contentIndex: 1, delta: "# Report\n", partial: message });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chunks.join(""), "# Report\n");
    assert.equal(progress.at(-1)?.phase, "report");
    output.push({
      type: "text_delta",
      contentIndex: 1,
      delta: "Evidence.</peek-report> tail",
      partial: message,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chunks.join(""), "# Report\nEvidence.");
    output.push({ type: "done", reason: "stop", message });
    const result = await pending;
    assert.equal(result.report, chunks.join(""));
    assert.equal(result.summary, "Short finding");
    assert.equal(result.reportMode, "tagged");
    assert.equal(result.metrics?.requests, 1);
    assert.equal(result.metrics?.toolCalls, 0);
    assert.equal(progress.at(-1)?.chars, result.report.length);
    assert.doesNotMatch(
      JSON.stringify(progress) + chunks.join(""),
      /PRIVATE_REASONING|sufficient evidence|peek-summary|peek-report|between|tail/,
    );
  } finally {
    investigation.dispose();
    await pending.catch(() => {});
  }
});

test("untagged terminal text uses only the last text block without an additional model request", async () => {
  const output = createAssistantMessageEventStream();
  let requests = 0;
  const chunks: string[] = [];
  const investigation = createInvestigation({
    snapshot: snapshot(),
    model,
    stream: async () => {
      requests++;
      return output;
    },
  });
  const pending = investigation.investigate("question", { onToken: (text) => chunks.push(text) });
  try {
    const message = response("private explanation");
    message.content.push({ type: "text", text: "fallback report" });
    output.push({ type: "start", partial: message });
    output.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "private explanation",
      partial: message,
    });
    output.push({
      type: "text_delta",
      contentIndex: 1,
      delta: "fallback report",
      partial: message,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(chunks, []);
    output.push({ type: "done", reason: "stop", message });
    const result = await pending;
    assert.equal(requests, 1);
    assert.deepEqual(chunks, ["fallback report"]);
    assert.equal(result.reportMode, "fallback");
    assert.equal(result.summary, "fallback report");
  } finally {
    investigation.dispose();
    await pending.catch(() => {});
  }
});

test("a failure after a visible tagged prefix never triggers a replay", async () => {
  const output = createAssistantMessageEventStream();
  let requests = 0;
  const chunks: string[] = [];
  const stages: string[] = [];
  const investigation = createInvestigation({
    snapshot: snapshot(),
    model,
    stream: async () => {
      requests++;
      return output;
    },
  });
  const pending = investigation.investigate("question", {
    onToken: (text) => chunks.push(text),
    onStage: (stage) => stages.push(stage),
  });
  const rejected = assert.rejects(pending, (error: any) => error.code === "context_overflow");
  try {
    const failed = response("<peek-report>partial report", "error");
    failed.errorMessage = "maximum context length exceeded";
    output.push({ type: "start", partial: failed });
    output.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "<peek-report>partial report",
      partial: failed,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(chunks, ["partial report"]);
    output.push({ type: "error", reason: "error", error: failed });
    await rejected;
    assert.equal(requests, 1);
    assert.equal(stages.at(-1), "error");
    assert.ok(!stages.includes("retrying"));
  } finally {
    investigation.dispose();
    await pending.catch(() => {});
  }
});

test("tagged text followed by tool calls is reset before the later terminal report", async () => {
  const first = call("read_session", { ids: ["U1"] });
  first.content[0] = { type: "text", text: "<peek-report>provisional</peek-report>" };
  const queue = [
    first,
    response(
      "preamble<peek-summary>Final</peek-summary><peek-report>verified answer</peek-report>tail",
    ),
  ];
  let visible = "";
  const events: string[] = [];
  const investigation = createInvestigation({
    snapshot: snapshot(),
    model,
    stream: async () => streamOf(queue.shift()!),
  });
  try {
    const result = await investigation.investigate("question", {
      onToken: (delta) => {
        visible += delta;
        events.push(delta);
      },
      onReset: () => {
        visible = "";
        events.push("RESET");
      },
    });
    assert.deepEqual(events, ["provisional", "RESET", "verified answer"]);
    assert.equal(visible, result.report);
    assert.equal(result.reportMode, "tagged");
    assert.equal(result.metrics?.requests, 2);
    assert.equal(result.metrics?.toolCalls, 1);
  } finally {
    investigation.dispose();
  }
});
