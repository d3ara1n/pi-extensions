import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyPatch } from "../src/apply.ts";
import { MemoryFileSystem } from "./memory-fs.ts";

const root = fileURLToPath(new URL("./fixtures/scenarios/", import.meta.url));
async function filesIn(directory: string): Promise<Record<string, string>> {
  try {
    const files: Record<string, string> = {};
    for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        files[path.slice(directory.length + 1).replaceAll("\\", "/")] = await readFile(
          path,
          "utf8",
        );
      }
    }
    return files;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

for (const scenario of await readdir(root, { withFileTypes: true })) {
  if (!scenario.isDirectory()) continue;
  const id = Number(scenario.name.slice(0, 3));
  test(`upstream fixture: ${scenario.name}`, async () => {
    const directory = join(root, scenario.name);
    const initial = await filesIn(join(directory, "input"));
    let expected = await filesIn(join(directory, "expected"));
    const patch = await readFile(join(directory, "patch.txt"), "utf8");
    const fs = new MemoryFileSystem(initial);
    // Upstream's CLI fixture runner uses PreserveLineEndings. Our pinned
    // default is NormalizeToLf; these explicit expectations document the delta.
    if (id === 23) expected = { "lines.txt": "ONE\ntwo\nbetween\nthree\n" };
    if (id === 24) expected = initial; // CR-only separators are not source lines in legacy mode.
    // Codex's tool verifies all operations before execution, unlike its CLI.
    if (id === 15) expected = initial;
    if ([5, 6, 7, 8, 9, 12, 13, 15, 24].includes(id)) {
      await assert.rejects(applyPatch(patch, fs.context()));
      assert.equal(fs.writes.length, 0);
    } else {
      await applyPatch(patch, fs.context());
    }
    assert.deepEqual(fs.snapshot(), expected);
  });
}
