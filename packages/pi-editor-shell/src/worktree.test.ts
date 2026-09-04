import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";

import { linkedWorktreeName, type WorktreeIO } from "./index.ts";

/** In-memory filesystem fake: path → file content, or `"dir"` for a directory.\n *  Keys and lookups go through path.resolve, so tests use plain absolute\n *  paths and no real file is ever touched. */
function fakeIO(entries: Record<string, string>): WorktreeIO {
  const map = new Map(Object.entries(entries).map(([k, v]) => [path.resolve(k), v]));
  return {
    isFile(p) {
      const v = map.get(path.resolve(p));
      return v === undefined ? undefined : v !== "dir";
    },
    readText(p) {
      const v = map.get(path.resolve(p));
      if (v === undefined || v === "dir") throw new Error(`ENOENT: ${p}`);
      return v;
    },
  };
}

describe("linkedWorktreeName", () => {
  it("returns null in the main worktree (.git is a directory)", () => {
    const io = fakeIO({ "/r/.git": "dir" });
    assert.equal(linkedWorktreeName("/r", io), null);
    assert.equal(linkedWorktreeName("/r/src", io), null);
  });

  it("returns the worktree name for a linked worktree", () => {
    const io = fakeIO({
      "/r/.git": "dir",
      "/wt/.git": "gitdir: /r/.git/worktrees/feature-x\n",
    });
    assert.equal(linkedWorktreeName("/wt", io), "feature-x");
    assert.equal(linkedWorktreeName("/wt/src/nested", io), "feature-x");
  });

  it("resolves a relative gitdir pointer", () => {
    const io = fakeIO({
      "/r/.git": "dir",
      "/wt/.git": "gitdir: ../r/.git/worktrees/rel-wt",
    });
    assert.equal(linkedWorktreeName("/wt", io), "rel-wt");
  });

  it("returns null for a submodule-style pointer", () => {
    const io = fakeIO({
      "/super/.git": "dir",
      "/super/lib/.git": "gitdir: /super/.git/modules/lib",
    });
    assert.equal(linkedWorktreeName("/super/lib", io), null);
  });

  it("returns null for a non-pointer .git file", () => {
    const io = fakeIO({ "/wt/.git": "garbage" });
    assert.equal(linkedWorktreeName("/wt", io), null);
  });

  it("returns null outside any repo", () => {
    assert.equal(linkedWorktreeName("/nowhere", fakeIO({})), null);
  });
});
