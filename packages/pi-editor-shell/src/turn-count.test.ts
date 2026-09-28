import * as assert from "node:assert/strict";
import { test } from "node:test";
import { countCompactions, countUserMessages } from "./turn-count.ts";

test("countUserMessages counts only persisted user messages on the supplied branch", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "first" } },
    { type: "message", message: { role: "assistant", content: "reply" } },
    { type: "message", message: { role: "assistant", content: "tool call" } },
    { type: "message", message: { role: "toolResult", content: "result" } },
    { type: "message", message: { role: "user", content: "follow-up" } },
    { type: "compaction" },
    { type: "custom_message", message: { role: "user" } },
  ];

  assert.equal(countUserMessages(branch), 2);
});

test("countUserMessages tolerates malformed branch entries", () => {
  assert.equal(countUserMessages([null, {}, { type: "message" }, { type: "message", message: null }]), 0);
});

test("countCompactions counts only persisted compactions on the supplied branch", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "first" } },
    { type: "compaction", summary: "first summary" },
    { type: "branch_summary", summary: "abandoned path" },
    { type: "compaction", summary: "second summary" },
    { type: "custom", customType: "extension" },
  ];

  assert.equal(countCompactions(branch), 2);
});

test("countCompactions tolerates malformed branch entries", () => {
  assert.equal(countCompactions([null, {}, { type: "message" }, { type: "compaction", summary: "ok" }]), 1);
});
