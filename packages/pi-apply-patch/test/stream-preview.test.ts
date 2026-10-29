import {
  generateDiffString,
  type Theme,
  type ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { renderPreviewBlock } from "../src/render.ts";
import { buildPreview, emptyPreviewState, type PreviewFileSystem } from "../src/stream-preview.ts";
import { makeApplyPatchTool } from "../src/tool.ts";
import { ioError, ROOT } from "./memory-fs.ts";

function fixture(files: Record<string, string>, links: Record<string, string> = {}) {
  const reads: string[] = [];
  const contents = new Map(
    Object.entries(files).map(([path, content]) => [resolve(ROOT, path), content]),
  );
  const canonical = new Map(
    Object.entries(links).map(([path, target]) => [resolve(ROOT, path), resolve(ROOT, target)]),
  );
  const fs: PreviewFileSystem = {
    realpath: (path) => canonical.get(path) ?? path,
    isFile: (path) => contents.has(path),
    readFile: (path) => {
      reads.push(path);
      const content = contents.get(path);
      if (content === undefined) throw ioError("ENOENT", path);
      return content;
    },
  };
  return { fs, reads };
}

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

test("call previews are discarded on execution start and completed history replay", () => {
  const renderCall = makeApplyPatchTool().renderCall!;
  const args = { input: "*** Begin Patch\n*** Add File: a.txt\n+new" };
  for (const finalState of [
    { executionStarted: true, isPartial: true },
    { executionStarted: false, isPartial: false },
  ]) {
    const context: ToolRenderContext = {
      args,
      toolCallId: "preview-lifecycle",
      state: {},
      cwd: ROOT,
      executionStarted: false,
      argsComplete: false,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
      durationMs: undefined,
      outputPad: 0,
      lastComponent: undefined,
      invalidate: () => {},
    };
    context.lastComponent = renderCall(args, plainTheme, context);
    assert.ok(context.state.previewState);

    Object.assign(context, finalState);
    renderCall(args, plainTheme, context);
    assert.equal(context.state.previewState, undefined);
  }
});

test("completed previews preserve source context after normalized matching", () => {
  const before = "  keep indent\r\nold\r\n";
  const { fs } = fixture({ "a.txt": before });
  const input = patch("*** Update File: a.txt", "@@", " keep indent", "-old", "+new");
  const [block] = buildPreview(input, ROOT, emptyPreviewState(), fs);

  assert.equal(block.state, "ready");
  assert.equal(block.diff, generateDiffString("  keep indent\nold\n", "  keep indent\nnew\n").diff);
});

test("streaming additions retain only completed sections and reuse their reads", () => {
  const { fs, reads } = fixture({ "a.txt": "old\n" });
  const state = emptyPreviewState();
  let input = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Add File: b.txt\n";
  for (let index = 0; index < 500; index++) {
    input += `+line ${index}\n`;
    const blocks = buildPreview(input, ROOT, state, fs);
    assert.equal(blocks[1].state, "partial");
    assert.equal(state.sections.size, 1);
  }
  const blocks = buildPreview(`${input}*** End Patch`, ROOT, state, fs);
  assert.equal(blocks[1].state, "ready");
  assert.equal(state.sections.size, 2);
  assert.deepEqual(reads, [resolve(ROOT, "a.txt")]);
});

test("completed deletions do not report a read failure", () => {
  const { fs, reads } = fixture({ "a.txt": "old\n" });
  const [block] = buildPreview(patch("*** Delete File: a.txt"), ROOT, emptyPreviewState(), fs);

  assert.equal(block.state, "ready");
  assert.doesNotMatch(
    renderPreviewBlock(block, plainTheme).join("\n"),
    /unavailable|not readable/i,
  );
  assert.deepEqual(reads, []);
});

test("preview reads outside paths when workspaceOnly is false", () => {
  const outside = resolve(ROOT, "../outside.txt");
  const { fs, reads } = fixture({ [outside]: "old\n" });
  const [block] = buildPreview(
    patch(`*** Update File: ${outside}`, "@@", "-old", "+new"),
    ROOT,
    emptyPreviewState(),
    fs,
    false,
  );
  assert.equal(block.state, "ready");
  assert.deepEqual(reads, [outside]);
});

test("preview reads follow canonical workspace boundaries", () => {
  const outside = resolve(ROOT, "../outside.txt");
  const { fs, reads } = fixture(
    { "a.txt": "old\n", [outside]: "old\n" },
    { "external.txt": outside, "internal.txt": "a.txt" },
  );
  for (const path of ["external.txt", outside]) {
    const [block] = buildPreview(
      patch(`*** Update File: ${path}`, "@@", "-old", "+new"),
      ROOT,
      emptyPreviewState(),
      fs,
    );
    assert.equal(block.state, "noread");
  }
  assert.deepEqual(reads, []);

  const [internal] = buildPreview(
    patch("*** Update File: internal.txt", "@@", "-old", "+new"),
    ROOT,
    emptyPreviewState(),
    fs,
  );
  assert.equal(internal.state, "ready");
  assert.deepEqual(reads, [resolve(ROOT, "a.txt")]);
});

test("invalid and unmatched sections do not hide later valid sections", () => {
  const { fs } = fixture({ "a.txt": "old\n" });
  const blocks = buildPreview(
    patch(
      "*** Update File: a.txt",
      "@@",
      "invalid hunk",
      "*** Update File: b.txt",
      "@@",
      "-missing",
      "+new",
      "*** Add File: c.txt",
      "+",
    ),
    ROOT,
    emptyPreviewState(),
    { ...fs, isFile: () => true, readFile: () => "old\n" },
  );

  assert.deepEqual(
    blocks.map((block) => block.state),
    ["invalid", "unmatched", "ready"],
  );
  assert.equal(blocks[2].diff, generateDiffString("", "\n").diff);
});

test("streaming preview sanitizes source text before applying theme styles", () => {
  const rows = renderPreviewBlock(
    {
      kind: "update",
      path: "\x1b[31ma.txt\x1b[0m",
      state: "partial",
      glimpse: ["+\x1b[2Jvalue\x07"],
    },
    plainTheme,
  ).join("\n");

  assert.doesNotMatch(rows, /[\x00-\x08\x0b-\x1f\x7f]/);
  assert.match(rows, /a\.txt/);
  assert.match(rows, /value/);
});
