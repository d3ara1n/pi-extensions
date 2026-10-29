import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { applyPatch, formatSummary } from "../src/apply.ts";
import { ioError, MemoryFileSystem, ROOT } from "./memory-fs.ts";

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

test("returns Codex summaries grouped by operation with actual before/after content", async () => {
  const fs = new MemoryFileSystem({ a: "old\n", d: "gone\n", existing: "before\n" });
  const result = await applyPatch(
    patch(
      "*** Delete File: d\n*** Update File: a\n*** Move to: nested/b\n@@\n-old\n+new\n*** Add File: existing\n+after",
    ),
    fs.context(),
  );
  assert.equal(
    formatSummary(result.files),
    "Success. Updated the following files:\nA existing\nM nested/b\nD d",
  );
  assert.equal(result.files[2].before, "before\n");
  assert.deepEqual(fs.snapshot(), { existing: "after\n", "nested/b": "new\n" });
});

test("accepts absolute paths within the workspace and rejects lexical escapes before writing", async () => {
  const fs = new MemoryFileSystem();
  await applyPatch(patch(`*** Add File: ${resolve(ROOT, "absolute")}\n+ok`), fs.context());
  for (const path of ["../outside", resolve(ROOT, "../sibling/a"), `${ROOT}-other/file`]) {
    const before = fs.writes.length;
    await assert.rejects(
      applyPatch(patch(`*** Add File: first\n+x\n*** Add File: ${path}\n+x`), fs.context()),
      /outside the workspace/,
    );
    assert.equal(fs.writes.length, before);
  }
});

test("rejects move destinations outside the workspace without modifying the source", async () => {
  const fs = new MemoryFileSystem({ source: "a\n" });
  await assert.rejects(
    applyPatch(patch("*** Update File: source\n*** Move to: ../outside\n@@\n-a\n+b"), fs.context()),
    /outside the workspace/,
  );
  assert.deepEqual(fs.snapshot(), { source: "a\n" });
  assert.equal(fs.writes.length, 0);
});

test("rejects source and missing destination paths traversing external symlinks", async () => {
  const fs = new MemoryFileSystem({ "../external/secret": "secret\n" });
  fs.links.set(resolve(ROOT, "escape"), resolve(ROOT, "../external"));
  for (const body of [
    "*** Add File: escape/new/deep/file\n+x",
    "*** Update File: escape/secret\n@@\n-secret\n+bad",
    "*** Delete File: escape/secret",
  ]) {
    await assert.rejects(applyPatch(patch(body), fs.context()), /resolves outside the workspace/);
  }
  assert.equal(fs.writes.length, 0);
});

test("rejects dangling symlinks and non-file targets", async () => {
  const fs = new MemoryFileSystem();
  fs.links.set(resolve(ROOT, "dangling"), resolve(ROOT, "missing"));
  for (const path of ["dangling", "dangling/child"]) {
    await assert.rejects(
      applyPatch(patch(`*** Add File: ${path}\n+x`), fs.context()),
      /Dangling symbolic link/,
    );
  }
  fs.addDir(resolve(ROOT, "directory"));
  await assert.rejects(
    applyPatch(patch("*** Add File: directory\n+x"), fs.context()),
    /not a regular file/,
  );
  await assert.rejects(
    applyPatch(patch("*** Delete File: ."), fs.context()),
    /workspace directory/,
  );
});

test("workspaceOnly false allows add, update, delete, and move outside the workspace", async () => {
  const fs = new MemoryFileSystem();
  const outside = resolve(ROOT, "../outside");
  fs.addDir(outside);
  fs.files.set(resolve(outside, "edit.txt"), "old\n");
  fs.files.set(resolve(outside, "delete.txt"), "gone\n");
  fs.files.set(resolve(outside, "move.txt"), "old\n");
  await applyPatch(
    patch(
      [
        `*** Add File: ${resolve(outside, "new.txt")}`,
        "+new",
        "*** Update File: ../outside/edit.txt",
        "@@",
        "-old",
        "+edited",
        `*** Delete File: ${resolve(outside, "delete.txt")}`,
        "*** Update File: ../outside/move.txt",
        "*** Move to: ../outside/moved.txt",
        "@@",
        "-old",
        "+moved",
      ].join("\n"),
    ),
    fs.context({ workspaceOnly: false }),
  );
  assert.equal(fs.files.get(resolve(outside, "new.txt")), "new\n");
  assert.equal(fs.files.get(resolve(outside, "edit.txt")), "edited\n");
  assert.equal(fs.files.has(resolve(outside, "delete.txt")), false);
  assert.equal(fs.files.has(resolve(outside, "move.txt")), false);
  assert.equal(fs.files.get(resolve(outside, "moved.txt")), "moved\n");
});

test("workspaceOnly false follows external symlinks", async () => {
  const fs = new MemoryFileSystem({ "../external/secret": "secret\n" });
  fs.links.set(resolve(ROOT, "escape"), resolve(ROOT, "../external"));
  await applyPatch(
    patch("*** Update File: escape/secret\n@@\n-secret\n+new"),
    fs.context({ workspaceOnly: false }),
  );
  assert.equal(fs.files.get(resolve(ROOT, "../external/secret")), "new\n");
});

test("preserves internal symlink update and delete semantics", async () => {
  const fs = new MemoryFileSystem({ target: "old\n" });
  fs.links.set(resolve(ROOT, "link"), resolve(ROOT, "target"));
  await applyPatch(patch("*** Update File: link\n@@\n-old\n+new"), fs.context());
  assert.equal(await fs.readFile(resolve(ROOT, "target")), "new\n");
  await applyPatch(patch("*** Delete File: link"), fs.context());
  assert.equal(await fs.readFile(resolve(ROOT, "target")), "new\n");
  assert.equal(fs.links.size, 0);
});

test("rejects duplicate resolved sources before writes and deduplicates queue keys", async () => {
  const fs = new MemoryFileSystem({ a: "old\n" });
  await assert.rejects(
    applyPatch(patch("*** Add File: a\n+one\n*** Add File: ./a\n+two"), fs.context()),
    /multiple operations target/,
  );
  assert.equal(fs.writes.length, 0);
  const keys: string[] = [];
  await applyPatch(
    patch("*** Update File: a\n*** Move to: z\n@@\n-old\n+new\n*** Add File: b\n+b"),
    fs.context({
      withFileQueue: async (path, action) => {
        keys.push(path);
        return action();
      },
    }),
  );
  assert.deepEqual(
    keys,
    ["a", "b", "z"].map((path) => resolve(ROOT, path)),
  );
});

test("rechecks symlink resolution after waiting for file queues", async () => {
  const fs = new MemoryFileSystem({ "inside/a": "old\n", "../external/a": "old\n" });
  fs.links.set(resolve(ROOT, "link"), resolve(ROOT, "inside"));
  await assert.rejects(
    applyPatch(
      patch("*** Update File: link/a\n@@\n-old\n+new"),
      fs.context({
        withFileQueue: async (_path, action) => {
          fs.links.set(resolve(ROOT, "link"), resolve(ROOT, "../external"));
          return action();
        },
      }),
    ),
    /outside the workspace/,
  );
  assert.equal(fs.writes.length, 0);
});

test("verification failure leaves all files untouched", async () => {
  const fs = new MemoryFileSystem({ a: "old\n" });
  await assert.rejects(
    applyPatch(
      patch("*** Add File: new\n+x\n*** Update File: a\n@@\n-missing\n+new"),
      fs.context(),
    ),
    (error: Error) =>
      /operations failed; no files were written/.test(error.message) &&
      /hunk 1: context lines not found/.test(error.message),
  );
  assert.equal(fs.writes.length, 0);
  assert.deepEqual(fs.snapshot(), { a: "old\n" });
});

test("rejections aggregate every failed operation and hunk without writing", async () => {
  const fs = new MemoryFileSystem({ a: "alpha\n", b: "one\ntwo\n", c: "fine\n" });
  const error = await applyPatch(
    patch(
      [
        "*** Update File: a",
        "@@",
        "-missing",
        "+X",
        "@@",
        "-absent",
        "+Y",
        "*** Update File: b",
        "@@",
        "-nope",
        "+Z",
        "*** Update File: c",
        "@@",
        "-fine",
        "+good",
      ].join("\n"),
    ),
    fs.context(),
  ).then(
    () => assert.fail("expected rejection"),
    (error: Error) => error,
  );
  assert.match(error.message, /2 of 3 operations failed; no files were written/);
  assert.match(error.message, /a \(update\): 2 of 2 hunks did not match/);
  assert.match(error.message, /hunk 1: context lines not found[\s\S]*hunk 2: context lines not found/);
  assert.match(error.message, /b \(update\): 1 of 1 hunks did not match/);
  assert.match(error.message, /verified but not written \(whole patch rejected\): c/);
  assert.equal(fs.writes.length, 0);
  assert.deepEqual(fs.snapshot(), { a: "alpha\n", b: "one\ntwo\n", c: "fine\n" });
});

test("later hunks are still searched after an earlier hunk fails", async () => {
  const fs = new MemoryFileSystem({ m: "gone\nkeep\n" });
  const error = await applyPatch(
    patch("*** Update File: m\n@@\n-missing\n+X\n@@\n-keep\n+KEPT"),
    fs.context(),
  ).then(
    () => assert.fail("expected rejection"),
    (error: Error) => error,
  );
  assert.match(error.message, /1 of 2 hunks did not match/);
  assert.match(error.message, /hunk 1: context lines not found/);
  assert.doesNotMatch(error.message, /hunk 2/);
});

test("drift diagnostics report candidates, ordering, and re-application", async () => {
  const fs = new MemoryFileSystem({
    w: "const  total = a  +  b;\n",
    r: "const t = compute(a, b);\n",
    s: "x\ny\n",
    e: "mid\nend\n",
  });
  const error = await applyPatch(
    patch(
      [
        "*** Update File: w",
        "@@",
        "-const total = a + b;",
        "+const total = sum(a, b);",
        "*** Update File: r",
        "@@",
        "-const t = add(a, b);",
        "+const t = compute(a, b);",
        "*** Update File: s",
        "@@",
        "-x",
        "+ONE",
        "@@",
        "-x",
        "+TWO",
        "*** Update File: e",
        "@@",
        "-mid",
        "+MID",
        "*** End of File",
      ].join("\n"),
    ),
    fs.context(),
  ).then(
    () => assert.fail("expected rejection"),
    (error: Error) => error,
  );
  assert.match(error.message, /closest match at line 1: 1 of 1 context lines changed \(whitespace-only drift\)/);
  assert.match(error.message, /the replacement text already occurs at line 1; this hunk may already be applied/);
  assert.match(error.message, /hunk 2: context lines not found \(search started at line 2\)[\s\S]*context matches at line 1, outside the searched range/);
  assert.match(error.message, /anchored to the end of the file\)[\s\S]*context matches at line 1, outside the searched range/);
});

test("write failures list the operations that were not applied", async () => {
  const fs = new MemoryFileSystem();
  fs.beforeWrite = (path) => {
    if (path === resolve(ROOT, "b")) throw ioError("EACCES", path);
  };
  await assert.rejects(
    applyPatch(
      patch("*** Add File: a\n+first\n*** Add File: b\n+second\n*** Add File: c\n+third"),
      fs.context(),
    ),
    /Filesystem changes may be partial;[\s\S]*Completed operations:\nA a[\s\S]*Not applied: b, c/,
  );
  assert.deepEqual(fs.snapshot(), { a: "first\n" });
});

test("successful updates carry per-hunk match details", async () => {
  const fs = new MemoryFileSystem({ a: "one\n", b: "two\n" });
  const result = await applyPatch(
    patch(
      "*** Update File: a\n@@\n-one\n+ONE\n@@\n+tail\n*** Update File: b\n@@\n-two  \n+TWO",
    ),
    fs.context(),
  );
  assert.deepEqual(result.files[0].hunks, [
    { hunk: 1, line: 1, strategy: "exact", occurrences: 1 },
    { hunk: 2, line: 2, strategy: "exact", occurrences: 1 },
  ]);
  assert.deepEqual(result.files[1].hunks, [
    { hunk: 1, line: 1, strategy: "trim_end", occurrences: 1 },
  ]);
  assert.equal(result.files[0].overwrites, undefined);
});

test("overwrites are reported for adds and moves onto existing files", async () => {
  const fs = new MemoryFileSystem({ dup: "old\n", dest: "d\n", src: "s\n" });
  const result = await applyPatch(
    patch(
      "*** Add File: fresh\n+n\n*** Add File: dup\n+new\n*** Update File: src\n*** Move to: dest\n@@\n-s\n+m",
    ),
    fs.context(),
  );
  assert.equal(result.files[0].overwrites, undefined);
  assert.equal(result.files[1].overwrites, true);
  assert.equal(result.files[2].overwrites, true);
  assert.deepEqual(fs.snapshot(), { fresh: "n\n", dup: "new\n", dest: "m\n" });
});

test("a source rewritten by an earlier move is rematched and flagged", async () => {
  const fs = new MemoryFileSystem({ a: "same\nkeep A\n", b: "same\nkeep B\n" });
  const result = await applyPatch(
    patch(
      "*** Update File: a\n*** Move to: b\n@@\n same\n*** Update File: b\n@@\n-same\n+changed",
    ),
    fs.context(),
  );
  assert.equal(result.files[1].rematched, true);
  assert.deepEqual(result.files[1].hunks, [
    { hunk: 1, line: 1, strategy: "exact", occurrences: 1 },
  ]);
  assert.deepEqual(fs.snapshot(), { b: "changed\nkeep A\n" });
});

test("I/O failures report partial application and retain already completed operations", async () => {
  const fs = new MemoryFileSystem();
  fs.beforeWrite = (path) => {
    if (path === resolve(ROOT, "b")) throw ioError("EACCES", path);
  };
  await assert.rejects(
    applyPatch(patch("*** Add File: a\n+first\n*** Add File: b\n+second"), fs.context()),
    /Filesystem changes may be partial;[\s\S]*Completed operations:\nA a/,
  );
  assert.deepEqual(fs.snapshot(), { a: "first\n" });
});

test("move write failures keep the source; unlink failures report the written destination", async () => {
  const fs = new MemoryFileSystem({ a: "old\n" });
  const input = patch("*** Update File: a\n*** Move to: b\n@@\n-old\n+new");
  fs.beforeWrite = (path) => {
    throw ioError("EACCES", path);
  };
  await assert.rejects(applyPatch(input, fs.context()), /may be partial/);
  assert.deepEqual(fs.snapshot(), { a: "old\n" });
  fs.beforeWrite = undefined;
  fs.beforeUnlink = (path) => {
    throw ioError("EACCES", path);
  };
  await assert.rejects(applyPatch(input, fs.context()), /inspect .*b before retrying/);
  assert.deepEqual(fs.snapshot(), { a: "old\n", b: "new\n" });
});

test("a move affecting a later source is rematched against its current contents", async () => {
  const fs = new MemoryFileSystem({ a: "same\nkeep A\n", b: "same\nkeep B\n" });
  await applyPatch(
    patch("*** Update File: a\n*** Move to: b\n@@\n same\n*** Update File: b\n@@\n-same\n+changed"),
    fs.context(),
  );
  assert.deepEqual(fs.snapshot(), { b: "changed\nkeep A\n" });
});

test("cancellation before execution and after queue waits does not write", async () => {
  for (const atQueue of [false, true]) {
    const fs = new MemoryFileSystem();
    const controller = new AbortController();
    if (!atQueue) controller.abort();
    await assert.rejects(
      applyPatch(
        patch("*** Add File: a\n+x"),
        fs.context({
          signal: controller.signal,
          withFileQueue: async (_path, action) => {
            controller.abort();
            return action();
          },
        }),
      ),
      /cancelled/,
    );
    assert.equal(fs.writes.length, 0);
  }
});

test("cancellation between operations reports completed changes", async () => {
  const fs = new MemoryFileSystem();
  const controller = new AbortController();
  fs.beforeWrite = () => controller.abort();
  await assert.rejects(
    applyPatch(
      patch("*** Add File: a\n+x\n*** Add File: b\n+y"),
      fs.context({ signal: controller.signal }),
    ),
    /cancelled[\s\S]*A a/,
  );
  assert.deepEqual(fs.snapshot(), { a: "x\n" });
});

test("a symlink workspace root supports both logical and canonical absolute paths", async () => {
  const fs = new MemoryFileSystem();
  const alias = resolve(dirname(ROOT), "workspace-alias");
  fs.links.set(alias, ROOT);
  await applyPatch(
    patch(
      `*** Add File: ${resolve(ROOT, "canonical")}\n+x\n*** Add File: ${resolve(alias, "logical")}\n+y`,
    ),
    fs.context({ cwd: alias }),
  );
  assert.deepEqual(fs.snapshot(), { canonical: "x\n", logical: "y\n" });
});

test("reports successful matches that may not be the intended location", async () => {
  const fs = new MemoryFileSystem({ dup: "x\ny\nx\n", indent: "  a\n", plain: "q\n" });
  const result = await applyPatch(
    patch("*** Update File: dup\n@@\n-x\n+z\n*** Update File: indent\n@@\n-a\n+b\n*** Update File: plain\n@@\n-q\n+r"),
    fs.context(),
  );
  const summary = formatSummary(result.files);
  assert.match(summary, /^Success\. Updated the following files:\nM dup\nM indent\nM plain\n\nMatch notes/);
  assert.match(summary, /- dup hunk 1 at line 1: context occurs 2 times in the file; this occurrence was edited/);
  assert.match(summary, /- indent hunk 1 at line 1: matched only after ignoring leading and trailing whitespace/);
  assert.doesNotMatch(summary, /plain hunk/);
});
