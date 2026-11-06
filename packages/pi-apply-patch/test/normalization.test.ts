import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyPatch, formatSummary } from "../src/apply.ts";
import { PatchApplicationError, formatNotices } from "../src/notices.ts";
import { makeApplyPatchTool } from "../src/tool.ts";
import { MemoryFileSystem, ROOT, ioError } from "./memory-fs.ts";

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

test("five deterministic repairs share the execution pipeline and model-visible notices", async () => {
  const fs = new MemoryFileSystem({ a: "anchor\nold\n", b: "keep\nold\n" });
  const tool = makeApplyPatchTool({ fs, withFileQueue: fs.context().withFileQueue });
  const input = `\`\`\`patch\n${patch("*** Add File: new\nraw\n\n*** Update File: skipped\n*** Update File: a\n@@anchor\n-old\n+NEW\n*** Update File: b\n@@ -1,2 +1,2 @@\n keep\n-old\n+NEW")}\n\`\`\``;
  const result = await tool.execute("repair", { input }, undefined, undefined, {
    cwd: ROOT,
    mode: "rpc",
  } as ExtensionContext);
  assert.deepEqual(fs.snapshot(), { a: "anchor\nNEW\n", b: "keep\nNEW\n", new: "raw\n\n" });
  assert.deepEqual(
    result.details.notices?.map((notice) => notice.code),
    ["markdown-wrapper", "add-prefix", "empty-update", "anchor-space", "numeric-hunk"],
  );
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(text, /^Success\./);
  assert.match(text, /Input repairs/);
  assert.match(text, /skipped.*that block made no changes/);
  for (const notice of result.details.notices ?? []) assert.ok(text.includes(notice.message));
  assert.deepEqual(JSON.parse(JSON.stringify(result.details)).notices, result.details.notices);
});

test("repairs remain visible on parse, path, match, and write failures", async () => {
  for (const [body, initial, errorPattern] of [
    ["*** Add File: a\nraw\n*** Unknown File: bad", {}, /not a valid hunk header/],
    ["*** Add File: ../outside\nraw", {}, /outside the workspace/],
    ["*** Update File: a\n@@missing\n-old\n+new", { a: "old\n" }, /anchor.*not found/],
  ] as const) {
    const fs = new MemoryFileSystem(initial);
    await assert.rejects(applyPatch(patch(body), fs.context()), (error: unknown) => {
      assert.ok(error instanceof PatchApplicationError);
      assert.match(error.message, errorPattern);
      assert.match(error.message, /Input repairs/);
      assert.ok(error.notices.some((notice) => notice.kind === "repair"));
      return true;
    });
    assert.equal(fs.writes.length, 0);
  }
  const fs = new MemoryFileSystem();
  fs.beforeWrite = (path) => {
    throw ioError("EACCES", path);
  };
  await assert.rejects(
    applyPatch(patch("*** Add File: a\nraw"), fs.context()),
    /apply_patch failed:[\s\S]*Input repairs[\s\S]*missing '\+' prefix/,
  );
});

test("empty Update removal is not reported as a successful write", async () => {
  const fs = new MemoryFileSystem({ a: "unchanged\n" });
  await assert.rejects(
    applyPatch(patch("*** Update File: a"), fs.context()),
    /empty patch[\s\S]*that block made no changes/,
  );
  assert.equal(fs.writes.length, 0);
  assert.deepEqual(fs.snapshot(), { a: "unchanged\n" });
});

test("numeric pure-addition hunks retain their failing anchor instead of appending", async () => {
  const fs = new MemoryFileSystem({ a: "keep\n" });
  await assert.rejects(
    applyPatch(patch("*** Update File: a\n@@ -1 +1 @@\n+tail"), fs.context()),
    /anchor.*not found/,
  );
  assert.deepEqual(fs.snapshot(), { a: "keep\n" });
  assert.equal(fs.writes.length, 0);
});

test("matching policy is unchanged while warnings use the same model-facing channel", async () => {
  const fs = new MemoryFileSystem({
    trailing: "a  \n",
    indent: "  a\n",
    unicode: "“a”\n",
    duplicate: "a\na\n",
    overwritten: "old\n",
  });
  const result = await applyPatch(
    patch(
      '*** Update File: trailing\n@@\n-a\n+b\n*** Update File: indent\n@@\n-a\n+b\n*** Update File: unicode\n@@\n-"a"\n+b\n*** Update File: duplicate\n@@\n-a\n+b\n*** Add File: overwritten\n+new',
    ),
    fs.context(),
  );
  assert.deepEqual(fs.snapshot(), {
    trailing: "b\n",
    indent: "b\n",
    unicode: "b\n",
    duplicate: "b\na\n",
    overwritten: "new\n",
  });
  assert.equal(result.notices.filter((notice) => notice.code === "normalized-match").length, 3);
  assert.ok(result.notices.some((notice) => notice.code === "repeated-context"));
  assert.ok(result.notices.some((notice) => notice.code === "overwrite"));
  assert.ok(result.notices.every((notice) => notice.kind === "warning"));
  const summary = formatSummary(result.files, result.notices);
  for (const notice of result.notices) assert.ok(summary.includes(notice.message));
});

test("warnings for completed operations survive a later partial write failure", async () => {
  const fs = new MemoryFileSystem({ a: "old\n" });
  fs.beforeWrite = (path) => {
    if (path === resolve(ROOT, "b")) throw ioError("EACCES", path);
  };
  await assert.rejects(
    applyPatch(patch("*** Add File: a\nraw\n*** Add File: b\n+new"), fs.context()),
    (error: unknown) => {
      assert.ok(error instanceof PatchApplicationError);
      assert.match(error.message, /Filesystem changes may be partial/);
      assert.match(error.message, /Input repairs/);
      assert.match(error.message, /Warnings:[\s\S]*overwrote an existing file/);
      assert.ok(error.notices.some((notice) => notice.code === "overwrite"));
      return true;
    },
  );
  assert.deepEqual(fs.snapshot(), { a: "raw\n" });
});

test("notice text is bounded without losing the structured repair list", async () => {
  const fs = new MemoryFileSystem();
  const body = Array.from({ length: 25 }, (_, index) => `*** Add File: file-${index}\nraw`).join(
    "\n",
  );
  const result = await applyPatch(patch(body), fs.context());
  assert.equal(result.notices.length, 25);
  assert.match(formatNotices(result.notices), /5 more repair notices/);
  assert.equal(fs.files.size, 25);
});

test("tool errors retain structured notices and the framework error flag", async () => {
  const fs = new MemoryFileSystem();
  const tool = makeApplyPatchTool({ fs, withFileQueue: fs.context().withFileQueue });
  const result = await tool.execute(
    "repair-error",
    { input: patch("*** Add File: ../outside\nraw") },
    undefined,
    undefined,
    { cwd: ROOT, mode: "rpc" } as ExtensionContext,
  );
  assert.equal(result.isError, true);
  assert.equal(result.details.notices?.[0].code, "add-prefix");
  assert.deepEqual(result.details.files, []);
  assert.match(
    result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
    /outside the workspace[\s\S]*Input repairs/,
  );
  assert.equal(fs.writes.length, 0);
});

test("EOF addition repair appends and reports the actual repair through RPC text and details", async () => {
  const fs = new MemoryFileSystem({ a: "existing\n" });
  const tool = makeApplyPatchTool({ fs, withFileQueue: fs.context().withFileQueue });
  const result = await tool.execute(
    "eof-addition",
    {
      input: patch("*** Update File: a\n@@\n existing\n*** End of File\n+added\n+"),
    },
    undefined,
    undefined,
    { cwd: ROOT, mode: "rpc" } as ExtensionContext,
  );
  assert.deepEqual(fs.snapshot(), { a: "existing\nadded\n\n" });
  const repair = result.details.notices?.find((notice) => notice.code === "eof-addition-hunk");
  assert.ok(repair);
  assert.equal(repair.line, 6);
  assert.ok(
    result.content.some((block) => block.type === "text" && block.text.includes(repair.message)),
  );
});

test("EOF addition repair cannot bypass the preceding hunk's EOF verification", async () => {
  const initial = { a: "existing\nnot-at-end\n" };
  const fs = new MemoryFileSystem(initial);
  await assert.rejects(
    applyPatch(patch("*** Update File: a\n@@\n existing\n*** End of File\n+added"), fs.context()),
    (error: unknown) => {
      assert.ok(error instanceof PatchApplicationError);
      assert.match(error.message, /verification failed/);
      assert.match(error.message, /not at the end of the file/);
      assert.ok(error.notices.some((notice) => notice.code === "eof-addition-hunk"));
      return true;
    },
  );
  assert.equal(fs.writes.length, 0);
  assert.deepEqual(fs.snapshot(), initial);
});
