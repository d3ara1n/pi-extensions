import * as assert from "node:assert/strict";
import { test } from "node:test";
import { countUserMessages } from "./turn-count.ts";

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
