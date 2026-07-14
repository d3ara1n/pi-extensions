/**
 * Tests for side-agent error surfacing.
 * Run: node --test packages/pi-scout/src/side-agent.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { callSideAgent, parseDecision } from "./side-agent.ts";

/** Minimal fake ModelRolesAPI — only completeWithRole is used. */
function fakeRolesApi(completeWithRole: () => Promise<any>): any {
  return { completeWithRole };
}

test("upstream error (stopReason error, no throw) carries detail for notify", async () => {
  const api = fakeRolesApi(async () => ({
    stopReason: "error",
    errorMessage: "服务内部错误（上游原因：all nodes failed to stream）",
    content: [],
  }));

  const decision = await callSideAgent(api, "utility", "sys", "user");

  // Status stays short; the long cause lives in errorDetail for notify.
  assert.equal(decision.source, "error");
  assert.equal(decision.reasoning, "upstream error");
  assert.match(decision.errorDetail ?? "", /all nodes failed to stream/);
});

test("upstream error with only stopReason (no message) still reports error", async () => {
  const api = fakeRolesApi(async () => ({ stopReason: "error", content: [] }));

  const decision = await callSideAgent(api, "utility", "sys", "user");

  assert.equal(decision.source, "error");
  assert.equal(decision.reasoning, "upstream error");
});

test("empty content without an error flag stays 'unparseable response'", async () => {
  // A model that returns truly empty content (no stopReason error) is a
  // genuine parse failure, not an upstream error — no errorDetail to notify.
  const api = fakeRolesApi(async () => ({ stopReason: "stop", content: [] }));

  const decision = await callSideAgent(api, "utility", "sys", "user");

  assert.equal(decision.source, "error");
  assert.equal(decision.reasoning, "unparseable response");
  assert.equal(decision.errorDetail, undefined);
});

test("valid <decision> parses normally", async () => {
  const api = fakeRolesApi(async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: "<decision>\nskills: none\nrole: null\nreasoning: trivial\n</decision>" }],
  }));

  const decision = await callSideAgent(api, "utility", "sys", "user");

  assert.equal(decision.source, "side-agent");
  assert.deepEqual(decision.fields, { skills: [], role: null });
  assert.equal(decision.reasoning, "trivial");
});

test("parseDecision fills missing module fields with disabled values", () => {
  const d = parseDecision("<decision>\nreasoning: only reasoning here\n</decision>");
  assert.equal(d.source, "side-agent");
  assert.deepEqual(d.fields, { skills: [], role: null });
});
