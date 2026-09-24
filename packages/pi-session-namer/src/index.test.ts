/**
 * Tests for conversation-turn collection from session branch entries.
 * Run: node --test packages/pi-session-namer/src/index.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { collectTurns, dueCheckpoint } from "./index.ts";

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

function namedBranch(count: number) {
  return [
    { type: "session_info", id: "name-1", name: "Initial title" },
    { type: "custom", customType: "pi-session-namer", data: { kind: "generated", sessionInfoId: "name-1" } },
    ...Array.from({ length: count }, (_, i) => [
      msg("user", `request ${i + 1}`),
      msg("assistant", `result ${i + 1}`),
    ]).flat(),
  ];
}

test("periodic naming is due only after completed checkpoint turns", () => {
  for (const checkpoint of [5, 10, 20, 50, 100]) {
    const branch = namedBranch(checkpoint);
    assert.equal(dueCheckpoint(branch, "Initial title")?.checkpoint, checkpoint);
    assert.equal(dueCheckpoint(branch.slice(0, -1), "Initial title"), undefined);
  }
  assert.equal(dueCheckpoint(namedBranch(6), "Initial title"), undefined);
});

test("periodic naming skips attempted checkpoints and explicit names", () => {
  const branch = namedBranch(5);
  branch.push({ type: "custom", customType: "pi-session-namer", data: { kind: "attempt", checkpoint: 5 } } as any);
  assert.equal(dueCheckpoint(branch, "Initial title"), undefined);

  const manuallyNamed = namedBranch(10);
  manuallyNamed.push({ type: "session_info", id: "name-2", name: "User title" } as any);
  assert.equal(dueCheckpoint(manuallyNamed, "User title"), undefined);
  manuallyNamed.push({ type: "session_info", id: "name-3", name: "Initial title" } as any);
  assert.equal(dueCheckpoint(manuallyNamed, "Initial title"), undefined);
  assert.equal(dueCheckpoint(namedBranch(5), "Different title"), undefined);
});

test("periodic naming ignores slash-command exchanges in its count", () => {
  const branch = namedBranch(4);
  branch.push(msg("user", "/namer:rename"), msg("assistant", "Renamed"));
  assert.equal(dueCheckpoint(branch, "Initial title"), undefined);
  branch.push(msg("user", "fifth request"), msg("assistant", "fifth result"));
  assert.equal(dueCheckpoint(branch, "Initial title")?.checkpoint, 5);
});
