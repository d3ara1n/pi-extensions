/**
 * Deterministic grep override tests. Ripgrep and built-in grep are injected;
 * fixture files live only in a per-test system temporary directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { computeLineHash } from "../core/hash.ts";
import { makeGrepOverrideWithBackend, type GrepBackend } from "./grep-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { getState } from "./state.ts";

type FakeOptions = {
  lines?: string[];
  files?: string[];
  code?: number | null;
  stderr?: string;
  error?: Error;
  onRun?: () => void;
};

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hl-grep-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function rgMatch(filePath: string, lineNumber: number, text: string): string {
  return JSON.stringify({
    type: "match",
    data: { path: { text: filePath }, line_number: lineNumber, lines: { text } },
  });
}

function fakeBackend(options: FakeOptions = {}) {
  const calls: { path: string; args: string[] }[] = [];
  const fileCalls: { directories: string[]; globs: string[] }[] = [];
  const delegates: any[][] = [];
  const backend: GrepBackend = {
    async findRg() {
      return "/fake/rg";
    },
    async listFiles(_path, directories, globs) {
      fileCalls.push({ directories, globs });
      return new Set(options.files ?? []);
    },
    async runRg(path, args, _signal, onLine) {
      calls.push({ path, args });
      options.onRun?.();
      if (options.error) throw options.error;
      for (const line of options.lines ?? []) {
        if (!onLine(line)) return { code: null, stderr: options.stderr ?? "", stopped: true };
      }
      return {
        code: options.code === undefined ? 0 : options.code,
        stderr: options.stderr ?? "",
        stopped: false,
      };
    },
    async delegate(...args) {
      delegates.push(args);
      return { content: [{ type: "text", text: "delegated" }], details: undefined };
    },
  };
  return { backend, calls, fileCalls, delegates };
}

const text = (result: any): string => result.content[0].text;
const call = (tool: any, params: any, signal?: AbortSignal) =>
  tool.execute("0", params, signal, undefined);

async function withEnabled<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const state = getState();
  const previous = state.config.enabled;
  state.config.enabled = enabled;
  try {
    return await fn();
  } finally {
    state.config.enabled = previous;
  }
}

test("grep TUI aligns line-number colons across file groups", () => {
  const raw = [
    "a.ts · 2 matches",
    "99#ABCD│  alpha",
    "100#ABCD│    beta",
    "b.ts · 1 match",
    "7#ABCD│gamma",
  ].join("\n");
  const tool = makeGrepOverrideWithBackend(".", {});
  const theme = { fg: (_color: string, value: string) => value };
  const result = { content: [{ type: "text", text: raw }] };
  const rendered = tool.renderResult(result, { isPartial: false, expanded: true }, theme, {}).render(80);
  assert.deepEqual(rendered.map((line) => line.trimEnd()), [
    "a.ts · 2 matches",
    "    99: › alpha",
    "   100: ›   beta",
    "b.ts · 1 match",
    "     7: gamma",
  ]);
});

test("formats parsed rg matches with full-line hash anchors", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      await writeFile(a, "alpha beta\ngamma\nalpha only\n");
      await writeFile(b, "alpha here\n");
      const fake = fakeBackend({
        lines: [
          "not json",
          JSON.stringify({ type: "begin" }),
          rgMatch(a, 1, "alpha beta\n"),
          rgMatch(a, 3, "alpha only\n"),
          rgMatch(b, 1, "alpha here\n"),
        ],
      });

      const tool = makeGrepOverrideWithBackend(dir, fake.backend);
      assert.deepEqual(tool.parameters.required, ["pattern"]);
      const result = await call(tool, {
        pattern: "alpha",
      });
      const output = text(result);
      assert.match(output, /a\.ts · 2 matches/);
      assert.match(output, /b\.ts · 1 match/);
      assert.match(output, new RegExp(`1#${computeLineHash(1, "alpha beta")}│alpha beta`));
      assert.match(output, /3#[0-9A-Z]+│alpha only/);
      assert.deepEqual(fake.calls[0], {
        path: "/fake/rg",
        args: ["--json", "--line-number", "--color=never", "--hidden", "-e", "alpha", "--", dir],
      });
    }),
  );
});

test("grep anchored=false preserves line numbers and indentation without hashes", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const file = join(dir, "a.ts");
      await writeFile(file, "  alpha\n\talpha two\n");
      const fake = fakeBackend({
        lines: [rgMatch(file, 1, "  alpha\n"), rgMatch(file, 2, "\talpha two\n")],
      });
      const tool = makeGrepOverrideWithBackend(dir, fake.backend);
      const result: any = await call(tool, { pattern: "alpha", anchored: false });
      const output = text(result);
      assert.match(output, /1│  alpha/);
      assert.match(output, /2│\talpha two/);
      assert.doesNotMatch(output, /#[0-9A-Z]+│/);
      assert.equal(result.details.hashlineView.kind, "grep");
    }),
  );
});

test("grep keeps full selected lines for the TUI while projecting long lines for the model", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const file = join(dir, "long.ts");
      const source = `const value = "${"x".repeat(700)}";`;
      await writeFile(file, `${source}\n`);
      const tool = makeGrepOverrideWithBackend(
        dir,
        fakeBackend({ lines: [rgMatch(file, 1, `${source}\n`)] }).backend,
      );
      const result: any = await call(tool, { pattern: "value" });
      const row = result.details.hashlineView.lines.find((line: any) => line.kind === "row").row;
      assert.equal(row.content, source);
      assert.ok(row.modelContent.length < source.length);
      assert.ok(text(result).length < source.length);
      const rendered = tool
        .renderResult(
          result,
          { isPartial: false, expanded: false },
          { fg: (_color: string, value: string) => value },
          {},
        )
        .render(40);
      assert.ok(rendered.every((line: string) => visibleWidth(line) <= 40), JSON.stringify(rendered));
    }),
  );
});

test("grep anchored=false uses its own output budget instead of charging hidden hashes", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const file = join(dir, "large.ts");
      const lines = Array.from(
        { length: 2000 },
        (_, index) => `${index.toString().padStart(4, "0")} ${"x".repeat(70)}`,
      );
      await writeFile(file, lines.join("\n"));
      const backend = fakeBackend({
        lines: lines.map((line, index) => rgMatch(file, index + 1, `${line}\n`)),
      });
      const tool = makeGrepOverrideWithBackend(dir, backend.backend);
      const anchored: any = await call(tool, { pattern: "x", limit: 2000 });
      const plain: any = await call(tool, { pattern: "x", limit: 2000, anchored: false });
      const countRows = (result: any) =>
        (text(result).match(/^\d+(?:#[A-Z0-9]+)?│/gm) ?? []).length;
      assert.ok(countRows(plain) > countRows(anchored));
      assert.ok(Buffer.byteLength(text(plain), "utf8") <= 50 * 1024);
      assert.ok(Buffer.byteLength(text(anchored), "utf8") <= 50 * 1024);
      const rendered = tool
        .renderResult(
          anchored,
          { isPartial: false, expanded: true },
          { fg: (_color: string, value: string) => value },
          {},
        )
        .render(120);
      const noticeIndex = rendered.findIndex((line: string) => line.startsWith("["));
      assert.ok(noticeIndex > 0);
      assert.equal(rendered[noticeIndex - 1], "");
    }),
  );
});

test("grep renderer is identical for anchored and unanchored model views", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const file = join(dir, "a.ts");
      await writeFile(file, "  alpha\n\talpha two\n");
      const make = () =>
        fakeBackend({
          lines: [rgMatch(file, 1, "  alpha\n"), rgMatch(file, 2, "\talpha two\n")],
        });
      const anchoredTool = makeGrepOverrideWithBackend(dir, make().backend);
      const plainTool = makeGrepOverrideWithBackend(dir, make().backend);
      const anchored: any = await call(anchoredTool, { pattern: "alpha" });
      const plain: any = await call(plainTool, { pattern: "alpha", anchored: false });
      const renderContext = { isError: false, args: {} };
      const a = anchoredTool.renderResult(
        anchored,
        { isPartial: false, expanded: true },
        { fg: (_color: string, value: string) => value, bold: (value: string) => value },
        renderContext,
      );
      const p = plainTool.renderResult(
        plain,
        { isPartial: false, expanded: true },
        { fg: (_color: string, value: string) => value, bold: (value: string) => value },
        renderContext,
      );
      assert.deepEqual(a.render(120), p.render(120));
    }),
  );
});

test("grep in a subdirectory returns a path that edits the matching file", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      await mkdir(join(dir, "src"));
      const original = "export const status = 1;\n";
      const rootFile = join(dir, "status.ts");
      const matchedFile = join(dir, "src", "status.ts");
      await writeFile(rootFile, original);
      await writeFile(matchedFile, original);
      const fake = fakeBackend({ lines: [rgMatch(matchedFile, 1, original)] });
      const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
        pattern: "status",
        path: "src",
      });
      const output = text(result);
      const displayPath = output.split(" · ")[0];
      const edit: any = makeEditOverride(dir);
      await call(edit, {
        path: displayPath,
        edits: [
          {
            op: "replace",
            anchor: { line: 1, hash: computeLineHash(1, original.trimEnd()) },
            body: ["export const status = 2;"],
          },
        ],
      });
      assert.equal(await readFile(matchedFile, "utf-8"), "export const status = 2;\n");
      assert.equal(await readFile(rootFile, "utf-8"), original);
    }),
  );
});

test("applies all, exclude, context, and CRLF filtering after rg output", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const file = join(dir, "a.ts");
      await writeFile(
        file,
        "outside-before\r\nalpha beta drop\r\nbefore survivor\r\nalpha beta\r\nafter survivor\r\nalpha only\r\noutside-after\r\n",
      );
      const fake = fakeBackend({
        lines: [
          rgMatch(file, 2, "alpha beta drop\r\n"),
          rgMatch(file, 4, "alpha beta\r\n"),
          rgMatch(file, 6, "alpha only\r\n"),
        ],
      });

      const tool = makeGrepOverrideWithBackend(dir, fake.backend);
      const contextSchema: any = tool.parameters.properties.context;
      assert.equal(contextSchema.type, "integer");
      assert.equal(contextSchema.minimum, 0);
      assert.equal(contextSchema.maximum, 20);
      const result = await call(tool, {
        pattern: ["alpha", "beta$"],
        matchMode: "all",
        excludePattern: "drop",
        context: 1.9,
      });
      assert.equal(
        text(result),
        [
          "a.ts · 1 match",
          `3#${computeLineHash(3, "before survivor")}│before survivor`,
          `4#${computeLineHash(4, "alpha beta")}│alpha beta`,
          `5#${computeLineHash(5, "after survivor")}│after survivor`,
        ].join("\n"),
      );
    }),
  );
});

test("context bounds apply to each side of a match, including direct runtime calls", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "a.ts");
    const lines = Array.from({ length: 45 }, (_, i) => i === 22 ? "needle" : `line ${i + 1}`);
    await writeFile(file, lines.join("\n"));
    const fake = fakeBackend({ lines: [rgMatch(file, 23, "needle\n")] });
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);

    for (const context of [20, 1_000]) {
      const output = text(await call(tool, { pattern: "needle", context })).split("\n");
      assert.equal(output.length, 42);
      assert.match(output[1], /^3#[0-9A-Z]+│line 3$/);
      assert.match(output[21], /^23#[0-9A-Z]+│needle$/);
      assert.match(output[41], /^43#[0-9A-Z]+│line 43$/);
    }
    for (const context of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const output = text(await call(tool, { pattern: "needle", context })).split("\n");
      assert.equal(output.length, 2);
      assert.match(output[1], /^23#[0-9A-Z]+│needle$/);
    }
  });
});

test("passes output flags and formats files and counts", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      await writeFile(a, "Foo a.b\n");
      await writeFile(b, "foo a.b\n");
      const fake = fakeBackend({ files: [a, b], lines: [rgMatch(a, 1, "Foo a.b\n"), rgMatch(b, 1, "foo a.b\n")] });

      const tool = makeGrepOverrideWithBackend(dir, fake.backend);
      const globSchema: any = tool.parameters.properties.glob;
      assert.deepEqual(globSchema.anyOf.map((option: any) => option.type), ["string", "array"]);
      const files = await call(tool, {
        pattern: ["Foo", "a.b"],
        path: ["a.ts", "b.ts"],
        glob: ["*.ts", "!**/*.test.ts"],
        ignoreCase: true,
        literal: true,
        wordMatch: true,
        outputMode: "files",
      });
      assert.equal(text(files), "a.ts\nb.ts");
      assert.deepEqual(fake.calls[0].args, [
        "--json",
        "--line-number",
        "--color=never",
        "--hidden",
        "--ignore-case",
        "--fixed-strings",
        "--word-regexp",
        "--glob",
        "*.ts",
        "--glob",
        "!**/*.test.ts",
        "-e",
        "Foo",
        "-e",
        "a.b",
        "--",
        a,
        b,
      ]);

      const count = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
        pattern: "foo",
        outputMode: "count",
      });
      assert.equal(text(count), "a.ts: 1\nb.ts: 1\nTotal: 2 matches in 2 files");
    }),
  );
});

test("glob filters explicit files and batches their parent directories", async () => {
  await withDir(async (dir) => {
    const kept = join(dir, "kept.ts");
    const excluded = join(dir, "excluded.test.ts");
    const nested = join(dir, "sub", "other.ts");
    await mkdir(join(dir, "sub"));
    await writeFile(nested, "needle\n");
    await writeFile(kept, "needle\n");
    await writeFile(excluded, "needle\n");
    const fake = fakeBackend({
      files: [kept, nested],
      lines: [rgMatch(kept, 1, "needle\n"), rgMatch(nested, 1, "needle\n")],
    });
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    const query = { pattern: "needle", path: ["kept.ts", "excluded.test.ts", "sub/other.ts"], glob: ["*.ts", "!**/*.test.ts"] };
    assert.match(text(await call(tool, query)), /│needle/);
    assert.deepEqual(fake.fileCalls, [{ directories: [dir, join(dir, "sub")], globs: query.glob }]);
    assert.deepEqual(fake.calls[0].args.slice(-3), ["--", kept, nested]);

    assert.equal(text(await call(tool, { ...query, path: "excluded.test.ts" })), "No matches found");
    assert.equal(fake.calls.length, 1);
  });
});

test("counts only surviving matches toward the limit and stops the fake runner", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const file = join(dir, "a.ts");
      await writeFile(file, "alpha beta\nalpha only\nalpha later\n");
      const fake = fakeBackend({
        lines: [
          rgMatch(file, 1, "alpha beta\n"),
          rgMatch(file, 2, "alpha only\n"),
          rgMatch(file, 3, "alpha later\n"),
        ],
      });

      const result = await call(makeGrepOverrideWithBackend(dir, fake.backend), {
        pattern: "alpha",
        excludePattern: "beta",
        limit: 1,
      });
      assert.match(text(result), /2#[0-9A-Z]+│alpha only/);
      assert.match(
        text(result),
        /\[1 matches limit reached\. Use limit=2 for more, or refine pattern\]/,
      );
    }),
  );
});

test("reports empty output and ripgrep execution failures", async () => {
  await withDir(async (dir) =>
    withEnabled(true, async () => {
      const empty = fakeBackend({ code: 1 });
      assert.equal(
        text(await call(makeGrepOverrideWithBackend(dir, empty.backend), { pattern: "missing" })),
        "No matches found",
      );

      const failed = fakeBackend({ code: 2, stderr: "bad regex" });
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, failed.backend), { pattern: "[" }),
        /bad regex/,
      );

      const rejected = fakeBackend({ error: new Error("spawn failed") });
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, rejected.backend), { pattern: "x" }),
        /spawn failed/,
      );
    }),
  );
});

test("delegates only safe fallbacks and rejects extended missing-rg requests", async () => {
  await withDir(async (dir) => {
    const absent = fakeBackend();
    absent.backend.findRg = async () => null;
    await withEnabled(true, async () => {
      assert.equal(
        text(await call(makeGrepOverrideWithBackend(dir, absent.backend), { pattern: "x" })),
        "delegated",
      );
      assert.deepEqual(absent.delegates.at(-1)?.[1], { pattern: "x" });
      const tool = makeGrepOverrideWithBackend(dir, absent.backend);
      for (const [context, expected] of [
        [1_000, 20],
        [1.9, 1],
        [-1, 0],
        [Number.POSITIVE_INFINITY, 0],
      ]) {
        const params = { pattern: "x", context };
        await call(tool, params);
        assert.equal(absent.delegates.at(-1)?.[1].context, expected);
        assert.equal(params.context, context);
      }
      await assert.rejects(
        call(makeGrepOverrideWithBackend(dir, absent.backend), {
          pattern: ["x", "y"],
          matchMode: "all",
        }),
        /ripgrep \(rg\) not found/,
      );
      await call(tool, { pattern: "x", glob: "*.ts" });
      assert.deepEqual(absent.delegates.at(-1)?.[1], { pattern: "x", glob: "*.ts" });
      await assert.rejects(
        call(tool, { pattern: "x", glob: ["*.ts", "!**/*.test.ts"] }),
        /ripgrep \(rg\) not found/,
      );
      const file = join(dir, "fixture.ts");
      await writeFile(file, "x\n");
      const delegatedBefore = absent.delegates.length;
      await assert.rejects(
        call(tool, { pattern: "x", path: file, glob: "*.ts" }),
        /cannot apply glob to an explicit file/,
      );
      assert.equal(absent.delegates.length, delegatedBefore);
      assert.equal(text(await call(tool, { pattern: "x", path: file })), "delegated");
      assert.equal(text(await call(tool, { pattern: "x", path: dir, glob: "*.ts" })), "delegated");
    });
  });
});

test("delegates an already-aborted call and rejects an abort during rg execution", async () => {
  await withDir(async (dir) => {
    const alreadyAborted = fakeBackend();
    const first = new AbortController();
    first.abort();
    assert.equal(
      text(
        await call(
          makeGrepOverrideWithBackend(dir, alreadyAborted.backend),
          { pattern: ["x", "y"] },
          first.signal,
        ),
      ),
      "delegated",
    );

    const controller = new AbortController();
    const interrupted = fakeBackend({ onRun: () => controller.abort() });
    await assert.rejects(
      call(
        makeGrepOverrideWithBackend(dir, interrupted.backend),
        { pattern: ["x", "y"], matchMode: "all" },
        controller.signal,
      ),
      /Operation aborted/,
    );
  });
});

test("keeps regex and case-sensitive defaults across rg and line filters", async () => {
  await withDir(async (dir) => {
    const target = join(dir, "case.ts");
    await writeFile(target, "FOO alpha\n");
    const fake = fakeBackend({ lines: [rgMatch(target, 1, "FOO alpha\n")] });
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    const query = { pattern: ["foo", "alpha"], matchMode: "all", excludePattern: "BETA" };

    assert.equal(text(await call(tool, query)), "No matches found");
    assert.match(text(await call(tool, { ...query, ignoreCase: true })), /FOO alpha/);
    assert.match(text(await call(tool, { pattern: "FOO", literal: true })), /FOO alpha/);
    assert.deepEqual(fake.calls.map(({ args }) => ({
      ignoreCase: args.includes("--ignore-case"),
      literal: args.includes("--fixed-strings"),
    })), [
      { ignoreCase: false, literal: false },
      { ignoreCase: true, literal: false },
      { ignoreCase: false, literal: true },
    ]);

    const invalid = fakeBackend({ code: 2, stderr: "regex parse error:\nerror: unclosed group" });
    await assert.rejects(
      call(makeGrepOverrideWithBackend(dir, invalid.backend), { pattern: "queueTool(" }),
      /regex parse error/,
    );
    assert.equal(invalid.calls.length, 1);
    assert.ok(!invalid.calls[0].args.includes("--fixed-strings"));
  });
});

test("native fallback forwards parameters unchanged and propagates regex errors", async () => {
  await withDir(async (dir) => {
    const fake = fakeBackend();
    fake.backend.findRg = async () => null;
    const tool = makeGrepOverrideWithBackend(dir, fake.backend);
    const cases = [
      { pattern: "foo" },
      { pattern: "(?i)foo" },
      { pattern: "queueTool(", literal: true, ignoreCase: true },
    ];
    for (const params of cases) {
      const input = { ...params, path: "fixture.ts", glob: "*.ts", context: 2, limit: 3 };
      assert.equal(text(await call(tool, input)), "delegated");
      assert.deepEqual(fake.delegates.at(-1)![1], input);
    }
    await call(tool, { pattern: "foo", anchored: false });
    assert.deepEqual(fake.delegates.at(-1)![1], { pattern: "foo" });
    assert.equal(fake.delegates.length, cases.length + 1);
    assert.equal(fake.calls.length, 0);
    fake.backend.delegate = async (...args) => {
      fake.delegates.push(args);
      throw new Error("regex parse error: unclosed group");
    };
    const failingTool = makeGrepOverrideWithBackend(dir, fake.backend);
    await assert.rejects(call(failingTool, { pattern: "queueTool(" }), /regex parse error/);
    assert.equal(fake.delegates.length, cases.length + 2);
  });
});
