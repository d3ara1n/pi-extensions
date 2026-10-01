/**
 * Regression tests for the partitioned fuzzy filter that keeps scoped
 * models on top while searching, and the palette item ordering that keeps
 * built-ins → native commands → editor-fill entries.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";
import { buildPaletteItems, partitionedFuzzyFilter } from "./index.ts";

/** Minimal fake of the pi API surface buildPaletteItems uses. */
function fakePi(
  commands: { name: string; description?: string; source?: "extension" | "skill" | "template" }[],
): ExtensionAPI {
  return { getCommands: () => commands } as unknown as ExtensionAPI;
}

// ── partitionedFuzzyFilter ─────────────────────────────────────────

test("partitionedFuzzyFilter concatenates partitions unchanged for empty query", () => {
  const primary = [{ label: "A" }, { label: "B" }];
  const secondary = [{ label: "C" }, { label: "D" }];
  const getText = (m: { label: string }) => m.label;

  assert.deepEqual(
    partitionedFuzzyFilter(primary, secondary, "", getText).map((m) => m.label),
    ["A", "B", "C", "D"],
  );
  // Whitespace-only is treated as no query.
  assert.deepEqual(
    partitionedFuzzyFilter(primary, secondary, "   ", getText).map((m) => m.label),
    ["A", "B", "C", "D"],
  );
});

test("partitionedFuzzyFilter keeps the primary partition on top while filtering", () => {
  const primary = [{ label: "alpha-scoped" }, { label: "beta-scoped" }];
  const secondary = [{ label: "alpha-other" }, { label: "beta-other" }];
  const getText = (m: { label: string }) => m.label;

  const result = partitionedFuzzyFilter(primary, secondary, "alpha", getText);

  // Both groups match, but the scoped (primary) match must come first — a
  // single fuzzyFilter pass would have ranked them by score and could flip
  // the order.
  assert.equal(result.length, 2);
  assert.equal(result[0].label, "alpha-scoped");
  assert.equal(result[1].label, "alpha-other");
});

test("partitionedFuzzyFilter drops non-matches independently per partition", () => {
  const primary = [{ label: "keep-scoped" }, { label: "drop-scoped" }];
  const secondary = [{ label: "keep-other" }, { label: "drop-other" }];
  const getText = (m: { label: string }) => m.label;

  const result = partitionedFuzzyFilter(primary, secondary, "keep", getText);

  assert.deepEqual(
    result.map((m) => m.label),
    ["keep-scoped", "keep-other"],
  );
});

test("partitionedFuzzyFilter returns only primary matches when secondary has none", () => {
  const primary = [{ label: "sonnet" }];
  const secondary = [{ label: "gpt-4o" }, { label: "gemini" }];
  const getText = (m: { label: string }) => m.label;

  const result = partitionedFuzzyFilter(primary, secondary, "son", getText);

  assert.deepEqual(
    result.map((m) => m.label),
    ["sonnet"],
  );
});

// ── buildPaletteItems ordering ─────────────────────────────────────

const idsBefore = new Set(paletteCommandRegistry.getAll().map((c) => c.id));
after(() => {
  for (const c of paletteCommandRegistry.getAll()) {
    if (!idsBefore.has(c.id)) paletteCommandRegistry.unregister(c.id);
  }
});

test("buildPaletteItems orders built-ins above native commands above editor fills", () => {
  paletteCommandRegistry.register({
    id: "test:peek",
    label: "Peek: Ask This Session",
    run: () => {},
  });

  const items = buildPaletteItems(
    fakePi([{ name: "some-command", description: "extension command", source: "extension" }]),
  );

  const ranks = items.map((item) =>
    item.category === "Built-in" ? 0 : item.action.type === "native" ? 1 : 2,
  );
  // Monotonically non-decreasing → no editor-fill entry sits above a native
  // entry, and no native entry sits above a built-in.
  assert.ok(ranks.every((r, i) => i === 0 || ranks[i - 1] <= r));

  const native = items.find((item) => item.value === "native:test:peek");
  assert.ok(native);
  assert.equal(native.label, "Peek: Ask This Session");
  assert.equal(native.action.type, "native");

  // Command/skill/template labels carry no category prefix — the page
  // breadcrumb already names the category, and root search shows it via
  // the description decoration.
  const cmd = items.find((item) => item.value === "cmd:some-command");
  assert.ok(cmd);
  assert.equal(cmd.label, "/some-command");
  assert.equal(cmd.category, "Command");
});

test("buildPaletteItems picks up native commands registered after load", () => {
  // The registry is read at palette-open time, so a late registration must
  // show up on the next build without any re-init.
  paletteCommandRegistry.register({ id: "test:late", label: "Registered Late", run: () => {} });

  const items = buildPaletteItems(fakePi([]));
  assert.ok(items.some((item) => item.value === "native:test:late"));
});

test("the root restore action targets the latest draft and disappears when there are no drafts", () => {
  const pi = fakePi([]);
  const drafts = [
    { id: "latest", text: "next task\nmore detail", savedAt: "2026-01-02T00:00:00Z" },
    { id: "earlier", text: "earlier task", savedAt: "2026-01-01T00:00:00Z" },
  ];
  const items = buildPaletteItems(pi, drafts);
  assert.equal(items[0].label, "Editor: Restore Latest Draft");
  assert.deepEqual(items[0].action, { type: "restore-draft", id: "latest" });
  assert.ok(items.some((item) => item.label === "Editor: Save Draft"));
  assert.equal(buildPaletteItems(pi).some((item) => item.value === "__restore"), false);
});
