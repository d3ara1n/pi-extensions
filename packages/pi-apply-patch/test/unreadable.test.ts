import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { applyPatch } from "../src/apply.ts";
import { makeDetails, renderPatchResult } from "../src/render.ts";
import { ioError, MemoryFileSystem, ROOT } from "./memory-fs.ts";

test("Add and Move can overwrite unreadable files without inventing a diff", async () => {
  const fs = new MemoryFileSystem({ unreadable: "secret", source: "old\n" });
  const read = fs.readFile.bind(fs);
  fs.readFile = async (path) => {
    if (path === resolve(ROOT, "unreadable")) throw ioError("EACCES", path);
    return read(path);
  };
  const result = await applyPatch(
    "*** Begin Patch\n*** Add File: unreadable\n+replaced\n*** End Patch",
    fs.context(),
  );
  assert.equal(result.files[0].before, undefined);
  const details = makeDetails(result.files);
  assert.equal(details.files[0].diff, undefined);
  assert.equal(details.files[0].added, undefined);
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  assert.match(
    renderPatchResult(details, "", true, false, theme).render(120).join("\n"),
    /Diff unavailable/,
  );
  await applyPatch(
    "*** Begin Patch\n*** Update File: source\n*** Move to: unreadable\n@@\n-old\n+moved\n*** End Patch",
    fs.context(),
  );
  assert.deepEqual(fs.snapshot(), { unreadable: "moved\n" });
});
