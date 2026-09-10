import assert from "node:assert/strict";
import test from "node:test";
import { appendActivity, consumeSteer } from "./activity.ts";
import { buildDisplayItems, formatDisplayItem, renderDisplayItems } from "./utils.ts";
import type { ActivityEntry } from "./types.ts";

const plain = (_color: string, text: string) => text;

test("pending entries stay below internal activity and consume in place", () => {
  const log: ActivityEntry[] = [];
  const first = appendActivity(log, { kind: "toolCall", id: "a", status: "running" });
  appendActivity(log, { kind: "steer", id: "s1", status: "queued", text: "correct" });
  appendActivity(log, { kind: "steer", id: "s2", status: "queued", text: "correct" });
  const second = appendActivity(log, { kind: "toolCall", id: "b", status: "running" });
  assert.deepEqual(log.map((e) => e.id), ["a", "b", "s1", "s2"]);
  assert.equal(log[first].id, "a");
  assert.equal(log[second].id, "b");
  const before = log.map((e) => e.id);
  assert.equal(consumeSteer(log, { role: "assistant", content: "correct" }), false);
  assert.equal(consumeSteer(log, { role: "user", content: "unrelated" }), false);
  assert.equal(consumeSteer(log, { role: "user", content: [{ type: "text", text: "correct" }] }), true);
  assert.deepEqual(log.map((e) => e.id), before);
  assert.deepEqual(log.slice(-2).map((e) => e.status), ["done", "queued"]);
  appendActivity(log, { kind: "thinking", id: "next", status: "running" });
  assert.deepEqual(log.map((e) => e.id), ["a", "b", "s1", "next", "s2"]);
  assert.equal(consumeSteer(log, { role: "user", content: "correct" }), true);
  assert.equal(consumeSteer(log, { role: "user", content: "correct" }), false);
});

test("queued items share the visible limit and consumption changes only the marker", () => {
  const log: ActivityEntry[] = Array.from({ length: 6 }, (_, i) => ({
    kind: "toolCall", id: `t${i}`, toolName: `tool${i}`, status: "done",
  }));
  appendActivity(log, { kind: "steer", id: "s", status: "queued", text: "first\nsecond" });
  const before = renderDisplayItems(buildDisplayItems(log), 5, plain);
  assert.equal(before.split("\n").length, 6); // Five items plus the existing history marker.
  assert.ok(!before.includes("tool1"));
  assert.ok(before.endsWith("\u21a9 steer (queued): first second"));
  consumeSteer(log, { role: "user", content: "first\nsecond" });
  const after = renderDisplayItems(buildDisplayItems(log), 5, plain);
  assert.equal(after, before.replace(" (queued)", ""));
  assert.equal(buildDisplayItems(log).length, 7);
});

test("queued rendering uses status for every display type and steer color follows delivery status", () => {
  const color = (name: string, text: string) => `<${name}>${text}</${name}>`;
  assert.match(formatDisplayItem({ type: "steer", status: "queued", text: "input" }, color), /^<accent>/);
  assert.match(formatDisplayItem({ type: "steer", status: "done", text: "input" }, color), /^<dim>/);
  assert.equal(formatDisplayItem({ type: "steer", status: "done", text: "queued" }, plain), "\u21a9 steer: queued");
  assert.match(formatDisplayItem({ type: "thinking", status: "queued" }, plain), /\(queued\)/);
  assert.match(formatDisplayItem({ type: "toolCall", name: "read", args: {}, status: "queued" }, plain), /\(queued\)/);
});
