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
    /verification failed: Failed to find expected lines/,
  );
  assert.equal(fs.writes.length, 0);
  assert.deepEqual(fs.snapshot(), { a: "old\n" });
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
