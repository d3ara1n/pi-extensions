import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeApplyPatchTool } from "../src/tool.ts";
import { renderRejection } from "../src/report.ts";
import { MemoryFileSystem, ROOT } from "./memory-fs.ts";


test("tool uses the execution workspace and returns plain text plus serializable details", async () => {
  const fs = new MemoryFileSystem();
  const tool = makeApplyPatchTool({ fs, withFileQueue: fs.context().withFileQueue });
  const result = await tool.execute(
    "call",
    { input: "*** Begin Patch\n*** Add File: x\n+first\n+second\n*** End Patch" },
    undefined,
    undefined,
    { cwd: ROOT, mode: "rpc" } as ExtensionContext,
  );
  assert.deepEqual(result.content, [
    { type: "text", text: "Success. Updated the following files:\nA x" },
  ]);
  assert.deepEqual(fs.snapshot(), { x: "first\nsecond\n" });
  assert.equal(result.details.files[0].added, 2);
  assert.equal(result.details.files[0].removed, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.details)).files[0].path, "x");
  assert.equal(tool.name, "apply_patch");
  assert.equal(tool.constrainedSampling && tool.constrainedSampling.type, "grammar");
  assert.equal(tool.exposure, "model-only");
  assert.deepEqual(tool.parameters.required, ["input"]);
});

test("tool failures reject so the framework can mark them as errors", async () => {
  const fs = new MemoryFileSystem();
  const tool = makeApplyPatchTool({ fs, withFileQueue: fs.context().withFileQueue });
  await assert.rejects(
    tool.execute("call", { input: "bad" }, undefined, undefined, { cwd: ROOT } as ExtensionContext),
    /apply_patch verification failed/,
  );
});

test("rejection reports bound echoed context and listed hunks", () => {
  const pattern = Array.from({ length: 20 }, (_, index) => `line ${index}`);
  const failed = (hunk: number) => ({
    status: "unmatched" as const,
    hunk,
    failure: { pattern, searchFrom: 1, endOfFile: false, candidates: [] },
  });
  const message = renderRejection({
    rejected: [
      {
        path: "big",
        kind: "update" as const,
        reason: "unmatched",
        outcomes: Array.from({ length: 8 }, (_, index) => failed(index + 1)),
      },
    ],
    verified: [],
  });
  assert.match(message, /… 14 of 20 lines omitted/);
  assert.equal(message.includes("| line 10"), false);
  assert.match(message, /… 2 more failed hunks/);
});

test("Responses protocol supports freeform, fallback, streaming escapes, and paired history", async () => {
  const ai = import.meta.resolve("@earendil-works/pi-ai");
  const { convertResponsesTools, convertResponsesMessages } = await import(
    new URL("./api/openai-responses-shared.js", ai).href
  );
  const { createGrammarToolInputProperties, appendGrammarToolInputJsonDelta } = await import(
    new URL("./api/constrained-sampling.js", ai).href
  );
  const tool = makeApplyPatchTool();
  const custom = convertResponsesTools([tool], { supportsOpenAIGrammarTools: true })[0];
  assert.equal(custom.type, "custom");
  assert.equal(custom.name, "apply_patch");
  assert.equal(custom.format.syntax, "lark");
  assert.match(custom.format.definition, /^start: begin_patch hunk\+ end_patch/);
  assert.equal(
    convertResponsesTools([tool], { supportsOpenAIGrammarTools: false })[0].type,
    "function",
  );

  const input = '*** Begin Patch\n*** Add File: x\n+"quoted" \\ path\n*** End Patch';
  const buffer = { input: "", started: false, closed: false };
  let delta = appendGrammarToolInputJsonDelta(buffer, "input", input.slice(0, 30), false) ?? "";
  delta += appendGrammarToolInputJsonDelta(buffer, "input", input, true) ?? "";
  assert.deepEqual(JSON.parse(delta), { input });
  const model = {
    id: "test",
    api: "openai-responses",
    provider: "openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  };
  const context = {
    tools: [tool],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_test|ctc_test", name: "apply_patch", arguments: { input } },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_test|ctc_test",
        toolName: "apply_patch",
        content: [{ type: "text", text: "Success." }],
        isError: false,
        timestamp: 1,
      },
    ],
  };
  for (const supported of [true, false, true]) {
    const history = convertResponsesMessages(model, context, new Set(["openai"]), {
      grammarToolInputProperties: createGrammarToolInputProperties([tool], supported),
    });
    assert.deepEqual(
      history.map((item: { type: string }) => item.type),
      supported
        ? ["custom_tool_call", "custom_tool_call_output"]
        : ["function_call", "function_call_output"],
    );
    assert.equal(history[0].call_id, history[1].call_id);
    assert.deepEqual(supported ? { input: history[0].input } : JSON.parse(history[0].arguments), {
      input,
    });
  }
});
