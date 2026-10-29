import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "./types.ts";
import { paths } from "./paths.ts";
import { isSupportedTool, SUPPORTED_TOOLS, TOOL_ADAPTERS } from "./tools/index.ts";

const cwd = paths.join(paths.cwd, "fixture-project");

test("registered tools supply defaults and exclude inherited object properties", () => {
  assert.deepEqual(DEFAULT_CONFIG.tools, SUPPORTED_TOOLS);
  assert.equal(isSupportedTool("toString"), false);
  assert.equal(isSupportedTool("unknown_tool"), false);
});

test("file, shell, and patch adapters interpret their own input fields", () => {
  const outside = paths.join(paths.root(cwd), "adapter-outside.txt");
  for (const name of ["write", "edit"] as const) {
    assert.deepEqual(TOOL_ADAPTERS[name].extract({ path: "a.txt" }, cwd), [
      { path: paths.resolve(cwd, "a.txt") },
    ]);
  }
  assert.ok(TOOL_ADAPTERS.bash.extract({ command: `cat ${outside}` }, cwd)
    .some((target) => target.path === outside));
  assert.deepEqual(TOOL_ADAPTERS.apply_patch.extract({ input: "*** Add File: ../b.txt\n+x" }, cwd)
    .map((target) => target.path), [paths.resolve(cwd, "../b.txt")]);
  for (const adapter of Object.values(TOOL_ADAPTERS)) {
    assert.deepEqual(adapter.extract({}, cwd), []);
  }
});
