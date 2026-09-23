import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionSnapshot } from "./snapshot.ts";

const entry = (id: string, message: unknown) => ({ type: "message", id, message }) as SessionEntry;

test("reference preserves tool arguments, results and errors without thinking by default", () => {
  const branch = [
    entry("a", { role: "assistant", content: [
      { type: "thinking", thinking: "private saved rationale", thinkingSignature: "opaque signature" },
      { type: "thinking", thinking: "redacted payload", redacted: true, thinkingSignature: "encrypted secret" },
      { type: "text", text: "Edited the file." },
      { type: "toolCall", id: "call1", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] } },
    ] }),
    entry("b", { role: "toolResult", toolCallId: "call1", toolName: "edit", isError: true, content: [
      { type: "text", text: "The operation failed." }, { type: "image", data: "SECRET_BASE64" },
    ], details: { patch: "saved patch" } }),
  ];
  const snapshot = new SessionSnapshot(branch, "2026-01-01T00:00:00Z");
  const reference = snapshot.reference();
  assert.match(reference, /"oldText":"before","newText":"after"/);
  assert.match(reference, /active context view/);
  assert.doesNotMatch(reference, /complete recorded/);
  assert.match(reference, /Tool result call1: edit; isError=true/);
  assert.match(reference, /saved patch/);
  assert.doesNotMatch(reference, /private saved rationale|SECRET_BASE64|opaque signature|redacted payload|encrypted secret/);
  const withThinking = snapshot.reference(true);
  assert.match(withThinking, /Saved thinking:\nprivate saved rationale/);
  assert.doesNotMatch(withThinking, /opaque signature|redacted payload|encrypted secret/);
  assert.doesNotMatch(snapshot.reference(), /private saved rationale/);
  (branch[0] as any).message.content[2].text = "changed later";
  assert.doesNotMatch(snapshot.reference(), /changed later/);
});

test("compaction, retained tail, branch summaries and extension messages remain available", () => {
  const snapshot = new SessionSnapshot([
    { type: "compaction", id: "c", summary: "Earlier work summary", retainedTail: [{ role: "user", content: "retained question" }] },
    { type: "branch_summary", id: "b", summary: "abandoned path summary" },
    { type: "custom_message", id: "e", customType: "context", content: "injected context", display: false },
    { type: "custom", id: "ignored", data: "extension private state" },
  ] as unknown as SessionEntry[]);
  const ref = snapshot.reference();
  for (const text of ["Earlier work summary", "retained question", "abandoned path summary", "injected context"]) assert.ok(ref.includes(text));
  assert.doesNotMatch(ref, /extension private state/);
});

test("large histories and long tool output are transmitted completely without previews or pagination", () => {
  const bodies = Array.from({ length: 40 }, (_, i) => `record-${i}: ${"界".repeat(3000)} needle-${i} ${"x".repeat(3000)}`);
  const snapshot = new SessionSnapshot(bodies.map((content, i) => entry(String(i), {
    role: "toolResult", toolName: "read", toolCallId: `call${i}`, content,
  })));
  const ref = snapshot.reference();
  assert.ok(ref.length > 240_000);
  for (const body of bodies) assert.ok(ref.includes(body));
  assert.doesNotMatch(ref, /Reference abbreviated|nextOffset|read_record|search_record/);
});

test("nested per-file diffs preserve deleted content without exposing unrelated metadata", () => {
  const snapshot = new SessionSnapshot([
    entry("patch", { role: "assistant", content: [{ type: "toolCall", id: "delete", name: "apply_patch", arguments: { patch: "*** Delete File: old.ts" } }] }),
    entry("result", { role: "toolResult", toolCallId: "delete", toolName: "apply_patch", content: [{ type: "text", text: "Deleted old.ts" }], details: {
      files: [{ kind: "delete", path: "old.ts", removed: 1, diff: "-const original = 731;", unrelated: "private metadata" }],
    } }),
  ]);
  assert.match(snapshot.reference(), /original = 731/);
  assert.doesNotMatch(snapshot.reference(), /private metadata/);
});

test("missing thinking is not fabricated and disposal releases the records", () => {
  const snapshot = new SessionSnapshot([entry("a", { role: "user", content: "hi" })]);
  assert.match(snapshot.reference(true), /missing\/redacted thinking cannot be reconstructed/);
  assert.doesNotMatch(snapshot.reference(true), /Saved thinking:/);
  snapshot.dispose();
  assert.match(snapshot.reference(), /empty conversation/);
});
