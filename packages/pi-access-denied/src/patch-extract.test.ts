import assert from "node:assert/strict";
import { test } from "node:test";
import { paths } from "./paths.ts";
import { extractPatchTargets } from "./tools/apply-patch.ts";

const cwd = paths.join(paths.cwd, "fixture-project");
const targets = (input: string) => extractPatchTargets(input, cwd).map((target) => target.path);

test("extracts add, update, delete, and move paths", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: a.txt",
    "+x",
    "*** Update File: src/b.ts",
    "*** Move to: src/c.ts",
    "@@",
    "-old",
    "+new",
    "*** Delete File: ../old.txt",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(targets(patch), [
    paths.resolve(cwd, "a.txt"), paths.resolve(cwd, "src/b.ts"),
    paths.resolve(cwd, "src/c.ts"), paths.resolve(cwd, "../old.txt"),
  ]);
});

test("deduplicates paths without interpreting patch body text as headers", () => {
  const patch = [
    "*** Begin Patch", "*** Add File: a.txt", "+*** Delete File: content.txt",
    "*** Update File: ./a.txt", "@@", " *** Delete File: context.txt",
    "-*** Add File: removed.txt", "+new", "*** End Patch",
  ].join("\n");
  assert.deepEqual(targets(patch), [paths.resolve(cwd, "a.txt")]);
});

test("extracts declared paths without validating the envelope or unknown markers", () => {
  const patch = [
    "<<'EOF'", "*** Begin Patch", "*** Unknown: metadata", "*** Update File: a.txt",
    "@@", "-old", "+new", "  *** End Patch", "EOF",
  ].join("\r\n");
  assert.deepEqual(targets(patch), [paths.resolve(cwd, "a.txt")]);
  assert.deepEqual(targets("*** Add File: a.txt\n+x"), [paths.resolve(cwd, "a.txt")]);
  assert.deepEqual(targets("not a patch"), []);
});

test("uses Unicode whitespace rules for headers and preserves BOM path characters", () => {
  const patch = [
    "*** Begin Patch", "\u0085*** Add File: a.txt\u0085", "+x",
    "*** Update File: b.txt\uFEFF", "*** Move to: c.txt\u0085", "@@", "-x", "+y",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(targets(patch), [
    paths.resolve(cwd, "a.txt"), paths.resolve(cwd, "b.txt\uFEFF"), paths.resolve(cwd, "c.txt"),
  ]);
});

test("resolves paths literally without expanding home or environment syntax", () => {
  assert.deepEqual(targets([
    "*** Begin Patch", "*** Add File: ~/literal.txt", "+x",
    "*** Add File: $HOME/literal.txt", "+x", "*** End Patch",
  ].join("\n")), [paths.resolve(cwd, "~/literal.txt"), paths.resolve(cwd, "$HOME/literal.txt")]);
});
