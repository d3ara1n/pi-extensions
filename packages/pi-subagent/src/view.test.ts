import test from "node:test";
import assert from "node:assert";
import { inheritedConversationFields, sortViewRuns, windowTabCells } from "./view.ts";
import type { RunHandle } from "./run.ts";

// ── Fakes ──────────────────────────────────────────────────────────

function fakeHandle(id: string, state: RunHandle["state"]): RunHandle {
  return { id, state } as unknown as RunHandle;
}

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

test("sortViewRuns orders newest first by numeric id (creation order)", () => {
  const out = sortViewRuns([
    fakeHandle("sub-2", "running"),
    fakeHandle("sub-10", "finished"),
    fakeHandle("sub-1", "failed"),
    fakeHandle("sub-9", "queued"),
  ]);
  assert.deepEqual(
    out.map((r) => r.id),
    ["sub-10", "sub-9", "sub-2", "sub-1"],
  );
});

test("sortViewRuns is state-agnostic — a run settling never reshuffles rows", () => {
  const before = sortViewRuns([
    fakeHandle("sub-1", "running"),
    fakeHandle("sub-2", "running"),
    fakeHandle("sub-3", "running"),
  ]);
  const after = sortViewRuns([
    fakeHandle("sub-1", "running"),
    fakeHandle("sub-2", "failed"),
    fakeHandle("sub-3", "finished"),
  ]);
  assert.deepEqual(
    after.map((r) => r.id),
    before.map((r) => r.id),
  );
});

// ── windowTabCells ─────────────────────────────────────────────────

test("windowTabCells returns everything when the row fits", () => {
  const cells = ["[a sub-1]", "[b sub-22]", "[c sub-333]"];
  const win = windowTabCells(cells, 1, 100);
  assert.deepEqual(win, { items: cells, leftClipped: false, rightClipped: false });
});

test("windowTabCells keeps the focused cell visible under a tight budget", () => {
  const cells = ["[a sub-1 x]", "[b sub-2 y]", "[c sub-3 z]"];
  // Cell widths with one separator space each: 13 + 12 = 25 fits the left
  // neighbor too; the right one (13) does not fit.
  const win = windowTabCells(cells, 1, 25);
  assert.equal(win.leftClipped, false); // sub-1 fits on the left
  assert.equal(win.rightClipped, true); // sub-3 does not fit
  assert.deepEqual(win.items, [cells[0], cells[1]]);
});

test("windowTabCells clips both sides around a mid-list focus", () => {
  const cells = ["[1]", "[22]", "[333]", "[4444]", "[55555]"];
  // Focused cell (width 6) plus left neighbor (width 5) = 11.
  const win = windowTabCells(cells, 2, 11);
  assert.deepEqual(win.items, [cells[1], cells[2]]);
  assert.equal(win.leftClipped, true);
  assert.equal(win.rightClipped, true);
});

test("windowTabCells still returns the focused cell when it alone overflows", () => {
  const cells = ["[tiny]", "[enormous-cell]"];
  const win = windowTabCells(cells, 1, 3);
  assert.deepEqual(win.items, [cells[1]]);
  assert.equal(win.leftClipped, true);
  assert.equal(win.rightClipped, false);
});

test("windowTabCells handles an empty list and clamps an out-of-range focus", () => {
  assert.deepEqual(windowTabCells([], 0, 50), { items: [], leftClipped: false, rightClipped: false });
  assert.deepEqual(windowTabCells(["[a]"], 99, 50).items, ["[a]"]);
});
