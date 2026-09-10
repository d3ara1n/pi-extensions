/**
 * Tests for the palette command registry: CRUD semantics, id overwrite, and
 * the globalThis singleton that keeps registrants and the palette connected
 * across module identities.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { paletteCommandRegistry, PaletteCommandRegistry, type PaletteCommand } from "./index.ts";

const cmd = (id: string, label = id): PaletteCommand => ({
  id,
  label,
  run: () => {},
});

// The registry is a process-wide singleton — restore it to the state each
// test found, so mutations never leak between test files in one process.
const idsBefore = new Set(paletteCommandRegistry.getAll().map((c) => c.id));
after(() => {
  for (const c of paletteCommandRegistry.getAll()) {
    if (!idsBefore.has(c.id)) paletteCommandRegistry.unregister(c.id);
  }
});

test("register adds a command retrievable by id", () => {
  paletteCommandRegistry.register(cmd("test:one", "Test One"));

  assert.equal(paletteCommandRegistry.get("test:one")?.label, "Test One");
  assert.ok(paletteCommandRegistry.getAll().some((c) => c.id === "test:one"));
});

test("register overwrites an existing id", () => {
  paletteCommandRegistry.register(cmd("test:dup", "First"));
  paletteCommandRegistry.register(cmd("test:dup", "Second"));

  assert.equal(paletteCommandRegistry.get("test:dup")?.label, "Second");
  const dupes = paletteCommandRegistry.getAll().filter((c) => c.id === "test:dup");
  assert.equal(dupes.length, 1);
});

test("unregister removes the command", () => {
  paletteCommandRegistry.register(cmd("test:gone"));
  paletteCommandRegistry.unregister("test:gone");

  assert.equal(paletteCommandRegistry.get("test:gone"), undefined);
  assert.ok(!paletteCommandRegistry.getAll().some((c) => c.id === "test:gone"));
});

test("getAll preserves registration order", () => {
  paletteCommandRegistry.register(cmd("test:order-a"));
  paletteCommandRegistry.register(cmd("test:order-b"));
  const ids = paletteCommandRegistry.getAll().map((c) => c.id);

  assert.ok(ids.indexOf("test:order-a") < ids.indexOf("test:order-b"));
});

test("paletteCommandRegistry is the globalThis singleton", () => {
  // Registrants and the palette may load this package under different module
  // identities; both must reach the same registry instance through Symbol.for.
  const shared = (globalThis as any)[Symbol.for("@d3ara1n/pi-command-palette-core/registry")];
  assert.equal(shared, paletteCommandRegistry);

  // A second export-time lookup also resolves to the existing singleton
  // rather than creating a fresh registry.
  const fresh = new PaletteCommandRegistry();
  assert.notEqual(fresh, paletteCommandRegistry);
});
