/**
 * Explicit real-ripgrep integration coverage. This is excluded from the default
 * test script and never delegates to Pi's built-in grep/download path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, constants, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { makeGrepOverrideWithBackend } from "../pi/grep-tool.ts";

async function findPathRg(): Promise<string | null> {
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? "rg.exe" : "rg");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

const rgPath = await findPathRg();

test("real rg emits anchored matches from a temporary directory", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-integration-"));
  try {
    const file = join(directory, "fixture.ts");
    await writeFile(file, "needle\nother\n");
    const tool = makeGrepOverrideWithBackend(directory, {
      delegate: async () => {
        throw new Error("integration test must not invoke the built-in grep delegate");
      },
    });

    for (const pattern of ["needle", ["needle"]]) {
      const result: any = await tool.execute("0", { pattern }, undefined, undefined);
      assert.match(result.content[0].text, /fixture\.ts · 1 match/);
      assert.match(result.content[0].text, /1#[0-9A-Z]+│needle/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg combines include and exclude globs in order", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-globs-"));
  try {
    for (const name of ["first.ts", "second.ts", "first.test.ts", "notes.md", "notes.txt"]) {
      await writeFile(join(directory, name), "needle\n");
    }
    const tool = makeGrepOverrideWithBackend(directory, {
      findRg: async () => rgPath,
      delegate: async () => {
        throw new Error("integration test must not invoke the built-in grep delegate");
      },
    });
    const result: any = await tool.execute("0", {
      pattern: "needle",
      glob: ["*.ts", "*.md", "!**/*.test.ts"],
      outputMode: "files",
    }, undefined, undefined);
    assert.deepEqual(result.content[0].text.split("\n").sort(), ["first.ts", "notes.md", "second.ts"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg applies globs to explicit files and mixed search paths", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-explicit-globs-"));
  try {
    await mkdir(join(directory, "sub"));
    await writeFile(join(directory, ".gitignore"), "ignored.ts\n");
    for (const name of ["keep.ts", "drop.test.ts", "ignored.ts", "sub/child.ts"]) {
      await writeFile(join(directory, name), "needle\n");
    }
    const tool = makeGrepOverrideWithBackend(directory, {
      findRg: async () => rgPath,
      delegate: async () => {
        throw new Error("integration test must not invoke the built-in grep delegate");
      },
    });
    const search = async (path: string | string[], glob: string | string[]) => {
      const result: any = await tool.execute("0", { pattern: "needle", path, glob, outputMode: "files" }, undefined, undefined);
      return result.content[0].text;
    };
    const globs = ["*.ts", "!**/*.test.ts"];
    assert.deepEqual(
      (await search(["drop.test.ts", "keep.ts", "ignored.ts"], globs)).split("\n").sort(),
      ["ignored.ts", "keep.ts"],
    );
    assert.equal(await search("drop.test.ts", "*.ts"), "drop.test.ts");
    assert.equal(await search("drop.test.ts", globs), "No matches found");
    assert.equal(await search(["drop.test.ts", "keep.ts"], "!**/*.test.ts"), "keep.ts");
    assert.equal(await search("sub/child.ts", "**/sub/*.ts"), "sub/child.ts");
    assert.deepEqual(
      (await search(["keep.ts", "sub/child.ts"], globs)).split("\n").sort(),
      ["keep.ts", "sub/child.ts"],
    );
    assert.deepEqual(
      (await search(["drop.test.ts", "sub", "keep.ts"], globs)).split("\n").sort(),
      ["keep.ts", "sub/child.ts"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg and line filters honor explicit case settings and Unicode folding", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-case-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "FOO abc\nfoo BAR\nfoo bar\nK zip\nk zip\n");
    const tool = makeGrepOverrideWithBackend(directory, {
      findRg: async () => rgPath,
      delegate: async () => {
        throw new Error("integration test must not invoke the built-in grep delegate");
      },
    });
    for (const ignoreCase of [undefined, false, true]) {
      const expectedCount = ignoreCase === true ? 3 : 2;
      for (const query of [
        { pattern: "foo\\S*" },
        { pattern: ["foo\\S*", "\\S+"], matchMode: "all" },
      ]) {
        const result: any = await tool.execute("0", { ...query, ignoreCase }, undefined, undefined);
        assert.match(result.content[0].text, new RegExp(`fixture\\.ts · ${expectedCount} matches`));
        assert.equal(result.content[0].text.includes("FOO abc"), ignoreCase === true);
      }
      const excluded: any = await tool.execute("0", {
        pattern: "foo\\S*", excludePattern: "bar", ignoreCase,
      }, undefined, undefined);
      assert.match(excluded.content[0].text, /fixture\.ts · 1 match/);
      assert.ok(excluded.content[0].text.includes(ignoreCase === true ? "FOO abc" : "foo BAR"));
    }
    const unicodeAll: any = await tool.execute("0", {
      pattern: ["k", "zip"], matchMode: "all", ignoreCase: true,
    }, undefined, undefined);
    assert.match(unicodeAll.content[0].text, /fixture\.ts · 2 matches/);
    assert.ok(unicodeAll.content[0].text.includes("K zip"));

    const unicodeExcluded: any = await tool.execute("0", {
      pattern: "zip", excludePattern: "k", ignoreCase: true,
    }, undefined, undefined);
    assert.equal(unicodeExcluded.content[0].text, "No matches found");
    const caseSensitive: any = await tool.execute("0", {
      pattern: "zip", excludePattern: "k",
    }, undefined, undefined);
    assert.match(caseSensitive.content[0].text, /│K zip/);
    assert.doesNotMatch(caseSensitive.content[0].text, /│k zip/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real rg searches regex by default and rejects invalid patterns", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-regex-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "FOO\nfoo\nqueueTool(\nfoo(?=bar)\n");
    const tool = makeGrepOverrideWithBackend(directory, {
      findRg: async () => rgPath,
      delegate: async () => {
        throw new Error("integration test must not invoke the built-in grep delegate");
      },
    });
    for (const pattern of ["(?i)^foo$", "(?P<name>foo)$"]) {
      const result: any = await tool.execute("0", { pattern }, undefined, undefined);
      assert.match(result.content[0].text, /│foo/);
    }
    for (const pattern of ["queueTool(", "foo(?=bar)"]) {
      await assert.rejects(
        tool.execute("0", { pattern }, undefined, undefined),
        /regex parse error/,
      );
    }
    const explicit: any = await tool.execute("0", { pattern: "queueTool(", literal: true }, undefined, undefined);
    assert.match(explicit.content[0].text, /│queueTool\(/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fallback forwards search settings unchanged to an rg-backed delegate", {
  skip: rgPath === null,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hl-grep-fallback-"));
  try {
    await writeFile(join(directory, "fixture.ts"), "FOO\nfoo\nqueueTool(\n");
    const delegate = makeGrepOverrideWithBackend(directory, {
      findRg: async () => rgPath,
      delegate: async () => { throw new Error("must not invoke the built-in download path"); },
    });
    const fallback = makeGrepOverrideWithBackend(directory, {
      findRg: async () => null,
      delegate: (...args) => delegate.execute(...args),
    });
    for (const pattern of ["foo", "(?i)^foo$", "(?P<name>foo)$"]) {
      const result: any = await fallback.execute("0", { pattern }, undefined, undefined);
      const output = result.content[0].text;
      assert.match(output, /│foo/);
      assert.equal(output.includes("│FOO"), pattern.includes("?i"));
    }
    await assert.rejects(fallback.execute("0", { pattern: "queueTool(" }, undefined, undefined), /regex parse error/);
    const literal: any = await fallback.execute("0", { pattern: "queueTool(", literal: true }, undefined, undefined);
    assert.match(literal.content[0].text, /│queueTool\(/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
