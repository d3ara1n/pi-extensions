import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { makeApplyPatchTool } from "../src/tool.ts";
import { makeDetails, renderPatchResult } from "../src/render.ts";
import { MemoryFileSystem, ROOT } from "./memory-fs.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

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

test("rendering sanitizes terminal escapes and keeps errors expandable", () => {
  const malicious = "\x1b]52;c;ZXZpbA==\x07\x1b[31msecret";
  const details = makeDetails([
    { kind: "add", path: malicious, before: "", after: `${malicious}\r\n` },
  ]);
  const output = renderPatchResult(details, "", true, false, theme).render(120).join("\n");
  assert.equal(output.includes("\x1b"), false);
  assert.equal(output.includes("52;c;"), false);
  assert.match(output, /A secret/);
  assert.match(output, /\+1/);
  assert.equal(details.files[0].diff.includes("\r"), false);
  const collapsed = renderPatchResult(undefined, "failed\nreason", false, true, theme)
    .render(120)
    .join("\n");
  assert.equal(collapsed.includes("reason"), false);
  assert.match(
    renderPatchResult(undefined, "failed\nreason", true, true, theme).render(120).join("\n"),
    /reason/,
  );
});

test("large result previews are bounded while details retain the full diff", () => {
  const details = makeDetails([
    { kind: "add", path: "large", before: "", after: "line\n".repeat(200) },
  ]);
  const output = renderPatchResult(details, "", true, false, theme).render(120).join("\n");
  assert.match(output, /more diff lines/);
  assert.equal(details.files[0].added, 200);
  assert.ok(output.split("\n").length < 130);
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
