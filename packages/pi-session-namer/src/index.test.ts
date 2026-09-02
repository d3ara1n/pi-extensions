/**
 * Tests for conversation-turn collection from session branch entries.
 * Run: node --test packages/pi-session-namer/src/index.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { collectTurns } from "./index.ts";

let seq = 0;
function msg(role: string, content: unknown) {
  return { type: "message", id: `m${++seq}`, message: { role, content } };
}

test("collectTurns pairs each user prompt with its assistant reply", () => {
  const entries = [
    msg("user", "review the project"),
    msg("assistant", [{ type: "text", text: "found two issues" }]),
    msg("user", "fix them"),
    msg("assistant", [{ type: "text", text: "fixed" }]),
  ];
  assert.deepEqual(collectTurns(entries), [
    { user: "review the project", assistant: "found two issues" },
    { user: "fix them", assistant: "fixed" },
  ]);
});

test("collectTurns keeps only the last assistant message of a run", () => {
  const entries = [
    msg("user", "look at this"),
    msg("assistant", "first take"),
    msg("assistant", [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }]),
    msg("assistant", "final take"),
  ];
  assert.deepEqual(collectTurns(entries), [{ user: "look at this", assistant: "final take" }]);
});

test("collectTurns skips slash-command exchanges entirely", () => {
  const entries = [
    msg("user", "/namer:rename"),
    msg("assistant", "regenerated"),
    msg("user", "real request"),
    msg("assistant", "real reply"),
  ];
  assert.deepEqual(collectTurns(entries), [{ user: "real request", assistant: "real reply" }]);
});

test("collectTurns keeps an open turn without a reply", () => {
  const entries = [msg("user", "in-flight prompt")];
  assert.deepEqual(collectTurns(entries), [{ user: "in-flight prompt" }]);
});

test("collectTurns tolerates an assistant reply before the first prompt", () => {
  const entries = [msg("assistant", "orphan reply"), msg("user", "hello")];
  assert.deepEqual(collectTurns(entries), [
    { user: "", assistant: "orphan reply" },
    { user: "hello" },
  ]);
});

test("collectTurns ignores text-free and tool-result entries", () => {
  const entries = [
    { type: "compaction", id: "c1", summary: "…" },
    msg("toolResult", [{ type: "text", text: "command output" }]),
    msg("user", [{ type: "tool_result", toolCallId: "t1", content: "file contents" }]),
    msg("user", "   "),
    msg("user", "hello"),
  ];
  assert.deepEqual(collectTurns(entries), [{ user: "hello" }]);
});
