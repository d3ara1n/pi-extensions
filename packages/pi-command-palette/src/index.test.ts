/**
 * Regression tests for model reference parsing, the partitioned fuzzy
 * filter that keeps scoped models on top while searching, and the palette
 * item ordering that keeps built-ins → native commands → editor-fill entries.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";
import { buildPaletteItems, parseModelRef, partitionedFuzzyFilter } from "./index.ts";

/** Minimal fake of the pi API surface buildPaletteItems uses. */
function fakePi(commands: { name: string; description?: string }[]): ExtensionAPI {
  return { getCommands: () => commands } as unknown as ExtensionAPI;
}

test("parseModelRef splits provider and model at the first slash", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-sonnet"), {
    provider: "anthropic",
    modelId: "claude-sonnet",
  });
  assert.deepEqual(parseModelRef("openrouter/vendor/model/with/slashes"), {
    provider: "openrouter",
    modelId: "vendor/model/with/slashes",
  });
});

test("parseModelRef preserves empty provider or model segments", () => {
  assert.equal(parseModelRef("model-without-provider"), undefined);
  assert.deepEqual(parseModelRef("/model"), { provider: "", modelId: "model" });
  assert.deepEqual(parseModelRef("provider/"), { provider: "provider", modelId: "" });
});

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
    fakePi([{ name: "some-command", description: "extension command" }]),
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
});

test("buildPaletteItems picks up native commands registered after load", () => {
  // The registry is read at palette-open time, so a late registration must
  // show up on the next build without any re-init.
  paletteCommandRegistry.register({ id: "test:late", label: "Registered Late", run: () => {} });

  const items = buildPaletteItems(fakePi([]));
  assert.ok(items.some((item) => item.value === "native:test:late"));
});
