import test from "node:test";
import assert from "node:assert";
import {
  filterDeliveredRuns,
  inheritedConversationFields,
  sortViewRuns,
} from "./view.ts";
import type { RunHandle } from "./run.ts";

// ── Fakes ──────────────────────────────────────────────────────────

function fakeHandle(id: string, state: RunHandle["state"]): RunHandle {
  return { id, state } as unknown as RunHandle;
}

// ── filterDeliveredRuns ────────────────────────────────────────────

test("filterDeliveredRuns drops delivered terminal runs, keeps live and undelivered", () => {
  const running = fakeHandle("sub-1", "running");
  const queued = fakeHandle("sub-2", "queued");
  const finishedUndelivered = fakeHandle("sub-3", "finished");
  const finishedDelivered = fakeHandle("sub-4", "finished");
  const failedDelivered = fakeHandle("sub-5", "failed");

  const out = filterDeliveredRuns(
    [running, queued, finishedUndelivered, finishedDelivered, failedDelivered],
    new Set(["sub-4", "sub-5"]),
  );

  assert.deepEqual(
    out.map((r) => r.id),
    ["sub-1", "sub-2", "sub-3"],
  );
});

// ── inheritedConversationFields ────────────────────────────────────

test("inheritedConversationFields returns aligned-view metadata without body text", () => {
  assert.deepEqual(inheritedConversationFields(50_000, true), [
    ["inherited", "yes"],
    ["size", "50k chars"],
    ["truncated", "yes"],
  ]);
  assert.deepEqual(inheritedConversationFields(0, false), [
    ["inherited", "yes"],
    ["size", "0 chars"],
    ["truncated", "no"],
  ]);
});

// ── sortViewRuns ───────────────────────────────────────────────────

test("sortViewRuns ranks running before finished, each group by id", () => {
  const out = sortViewRuns([
    fakeHandle("sub-3", "finished"),
    fakeHandle("sub-2", "running"),
    fakeHandle("sub-4", "running"),
    fakeHandle("sub-1", "failed"),
  ]);
  assert.deepEqual(
    out.map((r) => r.id),
    ["sub-2", "sub-4", "sub-1", "sub-3"],
  );
});
