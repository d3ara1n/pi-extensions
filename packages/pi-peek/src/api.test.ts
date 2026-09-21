import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, type Context, type AssistantMessage } from "@earendil-works/pi-ai";
import { initPeekAPI, shutdownPeekAPI, tryGetPeekAPI, type PeekDeps } from "./api.ts";
import { PEEK_GLOBAL_KEY } from "./types.ts";

const globalState = globalThis as unknown as Record<string, unknown>;

test("one-shot calls capture fresh records, while persistent investigations pin their snapshot and model", async () => {
  const saved = globalState[PEEK_GLOBAL_KEY];
  delete globalState[PEEK_GLOBAL_KEY];
  let value = "old source";
  let selectedModel = "first-model";
  const requests: { context: Context; modelId: string }[] = [];
  const roles = {
    resolveRole: () => ({ model: { id: selectedModel, provider: "offline", api: "openai-completions", contextWindow: 128000, maxTokens: 4096 } }),
    async streamWithRole(_role: string, context: Context, options: any) {
      requests.push({ context: structuredClone(context), modelId: options.model.id });
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant", content: [{ type: "text", text: "report" }], stopReason: "stop", timestamp: 1,
        api: "openai-completions", provider: "offline", model: options.model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } satisfies AssistantMessage;
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  } as unknown as NonNullable<PeekDeps["modelRoles"]>;
  try {
    const api = initPeekAPI({
      config: {}, modelRoles: roles,
      sessionManager: { getBranch: () => [
        { type: "message", id: "a", parentId: null, timestamp: "now", message: { role: "user", content: value, timestamp: 1 } },
        { type: "message", id: "b", parentId: "a", timestamp: "now", message: {
          role: "assistant", api: "openai-completions", provider: "offline", model: "main", timestamp: 1, stopReason: "stop",
          content: [{ type: "thinking", thinking: "optional saved thinking" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } },
      ] },
    });
    const investigation = api.createInvestigation();
    await investigation.investigate("first");
    value = "new source";
    selectedModel = "second-model";
    await investigation.investigate("follow-up");
    await api.investigate("one-shot");
    assert.equal(requests[0]!.context.systemPrompt, requests[1]!.context.systemPrompt);
    assert.match(requests[2]!.context.systemPrompt!, /new source/);
    assert.deepEqual(requests.map(r => r.modelId), ["first-model", "first-model", "second-model"]);
    assert.equal(requests[2]!.context.messages.length, 1);
    assert.doesNotMatch(requests[2]!.context.systemPrompt!, /optional saved thinking/);
    await api.investigate("thinking", { includeThinking: true });
    assert.match(requests[3]!.context.systemPrompt!, /optional saved thinking/);
    assert.match(api.serializeMainConversation({ includeThinking: true }), /optional saved thinking/);
    shutdownPeekAPI();
    assert.equal(tryGetPeekAPI(), undefined);
    await assert.rejects(investigation.investigate("after shutdown"), /closed/);
    assert.throws(() => api.createInvestigation(), /closed/);
  } finally {
    shutdownPeekAPI();
    if (saved === undefined) delete globalState[PEEK_GLOBAL_KEY];
    else globalState[PEEK_GLOBAL_KEY] = saved;
  }
});
