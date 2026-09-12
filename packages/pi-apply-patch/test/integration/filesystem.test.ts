import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatch, nodeFileSystem, type ApplyContext } from "../../src/apply.ts";

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
async function sandbox(
  action: (ctx: ApplyContext, outside: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-apply-patch-"));
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  try {
    await fs.mkdir(cwd);
    await fs.mkdir(outside);
    await action({ cwd, fs: nodeFileSystem, withFileQueue: withFileMutationQueue }, outside);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("real filesystem: add, overwrite, move, delete, prevalidation, and file permissions", async () => {
  await sandbox(async (ctx) => {
    await fs.writeFile(join(ctx.cwd, "script"), "old\n", { mode: 0o755 });
    await applyPatch(
      patch("*** Update File: script\n@@\n-old\n+new\n*** Add File: nested/new\n+created"),
      ctx,
    );
    assert.equal(await fs.readFile(join(ctx.cwd, "script"), "utf8"), "new\n");
    if (process.platform !== "win32")
      assert.equal((await fs.stat(join(ctx.cwd, "script"))).mode & 0o777, 0o755);
    await applyPatch(
      patch(
        "*** Update File: script\n*** Move to: moved/deep/script\n@@\n-new\n+moved\n*** Delete File: nested/new",
      ),
      ctx,
    );
    assert.equal(await fs.readFile(join(ctx.cwd, "moved/deep/script"), "utf8"), "moved\n");
    await assert.rejects(fs.stat(join(ctx.cwd, "script")), { code: "ENOENT" });
    await assert.rejects(
      applyPatch(
        patch("*** Add File: must-not-exist\n+x\n*** Update File: missing\n@@\n-x\n+y"),
        ctx,
      ),
      /verification failed/,
    );
    await assert.rejects(fs.stat(join(ctx.cwd, "must-not-exist")), { code: "ENOENT" });
  });
});

test("real filesystem: symlink escapes and dangling paths are blocked", async (t) => {
  await sandbox(async (ctx, outside) => {
    await fs.writeFile(join(outside, "secret"), "secret\n");
    try {
      await fs.symlink(
        outside,
        join(ctx.cwd, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "ENOSYS"].includes(String(error.code))
      ) {
        t.skip("Symbolic links are unavailable in this environment.");
        return;
      }
      throw error;
    }
    for (const body of [
      "*** Add File: escape/new/deep/file\n+x",
      "*** Update File: escape/secret\n@@\n-secret\n+changed",
      "*** Delete File: escape/secret",
    ]) {
      await assert.rejects(applyPatch(patch(body), ctx), /outside the workspace/);
    }
    assert.equal(await fs.readFile(join(outside, "secret"), "utf8"), "secret\n");
    await assert.rejects(fs.stat(join(outside, "new")), { code: "ENOENT" });
  });
});

test("real filesystem: UTF-8 decoding preserves BOMs and rejects invalid source bytes", async () => {
  await sandbox(async (ctx) => {
    await fs.writeFile(join(ctx.cwd, "bom"), "\ufefffirst\nold\n");
    await applyPatch(patch("*** Update File: bom\n@@\n-old\n+new"), ctx);
    assert.equal(await fs.readFile(join(ctx.cwd, "bom"), "utf8"), "\ufefffirst\nnew\n");
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    await fs.writeFile(join(ctx.cwd, "binary"), bytes);
    await assert.rejects(
      applyPatch(patch("*** Update File: binary\n@@\n+x"), ctx),
      /verification failed/,
    );
    assert.deepEqual(await fs.readFile(join(ctx.cwd, "binary")), bytes);
    const overwritten = await applyPatch(patch("*** Add File: binary\n+text"), ctx);
    assert.equal(overwritten.files[0].before, undefined);
    assert.equal(await fs.readFile(join(ctx.cwd, "binary"), "utf8"), "text\n");
    await fs.writeFile(join(ctx.cwd, "binary"), bytes);
    await applyPatch(patch("*** Update File: bom\n*** Move to: binary\n@@\n-new\n+moved"), ctx);
    assert.equal(await fs.readFile(join(ctx.cwd, "binary"), "utf8"), "\ufefffirst\nmoved\n");
  });
});

test("real filesystem: overlapping multi-file patches acquire queues in a consistent order", {
  timeout: 5_000,
}, async () => {
  await sandbox(async (ctx) => {
    await Promise.all([
      applyPatch(patch("*** Add File: a\n+first\n*** Add File: b\n+first"), ctx),
      applyPatch(patch("*** Add File: b\n+second\n*** Add File: a\n+second"), ctx),
    ]);
    const a = await fs.readFile(join(ctx.cwd, "a"), "utf8");
    const b = await fs.readFile(join(ctx.cwd, "b"), "utf8");
    assert.equal(a, b);
    assert.ok(["first\n", "second\n"].includes(a));
  });
});
