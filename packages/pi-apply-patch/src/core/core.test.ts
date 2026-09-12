import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch } from "./parser.ts";
import { seekSequence } from "./matcher.ts";
import { applyUpdate } from "./update.ts";

function update(source: string, body: string): string {
  const operation = parsePatch(`*** Begin Patch\n*** Update File: file.txt\n${body}\n*** End Patch`)
    .operations[0];
  assert.equal(operation.kind, "update");
  return applyUpdate(source, operation.chunks, "file.txt");
}

test("parses mixed operations, literal quoted paths, moves, and multiple chunks", () => {
  const patch = parsePatch(
    "*** Begin Patch\n*** Add File: 'a b'\n+x  \n*** Update File: a\n*** Move to: b\n@@ fn a\n-x\n+y\n@@\n z\n*** End of File\n*** Delete File: c\n*** End Patch",
  );
  assert.deepEqual(patch.operations[0], { kind: "add", path: "'a b'", content: "x  \n" });
  const moved = patch.operations[1];
  assert.equal(moved.kind, "update");
  assert.equal(moved.moveTo, "b");
  assert.equal(moved.chunks.length, 2);
  assert.equal(moved.chunks[0].anchor, "fn a");
  assert.equal(moved.chunks[1].endOfFile, true);
});

test("accepts upstream lenient envelope forms and empty additions", () => {
  for (const opener of ["<<EOF", "<<'EOF'", '<<"EOF"']) {
    assert.deepEqual(
      parsePatch(`${opener}\n *** Begin Patch \n *** Add File: empty \n *** End Patch \nEOF`)
        .operations,
      [{ kind: "add", path: "empty", content: "" }],
    );
  }
  assert.equal(
    parsePatch("\r\n*** Begin Patch\r\n*** Add File: x\r\n+hi\r\n*** End Patch\r\n").operations
      .length,
    1,
  );
});

test("rejects malformed patches and reports the source line", () => {
  for (const body of ["", "@@", "*** Move to: other", "@@\n@@"]) {
    assert.throws(
      () =>
        parsePatch(`*** Begin Patch\n*** Update File: a\n${body ? `${body}\n` : ""}*** End Patch`),
      /invalid hunk at line/,
    );
  }
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Unknown File: a\n*** End Patch"),
    /not a valid hunk header/,
  );
  assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: a\n+x"), /last line/);
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** End Patch\nextra\n*** End Patch"),
    /last line/,
  );
  assert.throws(
    () =>
      parsePatch("*** Begin Patch\n*** Environment ID: remote\n*** Add File: x\n+x\n*** End Patch"),
    /Environment IDs/,
  );
});

test("matches the upstream batch parser's final duplicate End marker handling", () => {
  assert.deepEqual(
    parsePatch("*** Begin Patch\n*** Add File: x\n+x\n*** End Patch\n*** End Patch").operations,
    [{ kind: "add", path: "x", content: "x\n" }],
  );
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** End Patch\n*** End Patch\n*** End Patch"),
    /last line/,
  );
});

test("keeps patch body whitespace and accepts implicit first chunks and bare context lines", () => {
  assert.equal(update("a  \n\nb\n", "-a  \n+A  \n\n b"), "A  \n\nb\n");
  assert.throws(() => update("a\n", "@@\n-a\n+b\n*** End of File\n+x"), /Expected update hunk/);
});

test("prefers a later exact match to an earlier fuzzy match", () => {
  assert.equal(seekSequence(["  x", "x"], ["x"], 0), 1);
  assert.equal(update("x\nx\n", "@@\n-x\n+y"), "y\nx\n");
});

test("matches trailing whitespace, indentation, punctuation, and Unicode spaces in order", () => {
  assert.equal(seekSequence(["x  "], ["x"], 0), 0);
  assert.equal(seekSequence(["  x  "], ["x"], 0), 0);
  assert.equal(seekSequence(["“hello”\u00a0—\u00a0‘world’"], ["\"hello\" - 'world'"], 0), 0);
  assert.equal(seekSequence(["X"], ["x"], 0), undefined);
  assert.equal(seekSequence(["\u0085x\u0085"], ["x"], 0), 0);
  assert.equal(seekSequence(["\ufeffx"], ["x"], 0), undefined);
});

test("anchors advance past their context and subsequent chunks search forward", () => {
  assert.equal(update("fn a\nx\nfn b\nx\n", "@@ fn b\n-x\n+y"), "fn a\nx\nfn b\ny\n");
  assert.equal(update("x\nx\n", "@@\n-x\n+a\n@@\n-x\n+b"), "a\nb\n");
  assert.throws(() => update("fn a\nx\n", "@@ fn a\n-fn a\n+b"), /Failed to find expected lines/);
  assert.throws(() => update("a\nb\n", "@@\n-b\n+B\n@@\n-a\n+A"), /Failed to find expected lines/);
  assert.throws(() => update("a\n", "@@ missing\n-a\n+b"), /Failed to find context 'missing'/);
});

test("pure additions append, including when a skip-ahead anchor is present", () => {
  assert.equal(update("fn a\nx\n", "@@ fn a\n+tail"), "fn a\nx\ntail\n");
  assert.equal(update("", "@@\n+first"), "first\n");
  assert.equal(update("a\n\n", "@@\n+tail"), "a\ntail\n");
});

test("EOF anchors only match the end and retain upstream legacy overlapping behavior", () => {
  assert.equal(update("x\nx\n", "@@\n-x\n+y\n*** End of File"), "x\ny\n");
  assert.throws(
    () => update("x\ny\n", "@@\n-x\n+z\n*** End of File"),
    /Failed to find expected lines/,
  );
  assert.equal(update("one\n", "@@\n-one\n+first\n@@\n-one\n+second\n*** End of File"), "first\n");
});

test("retries trailing empty context and follows the default line-ending baseline", () => {
  assert.equal(update("a", "@@\n-a\n+b\n "), "b\n");
  assert.equal(update("one\r\ntwo\r\n", "@@\n-one\n+ONE"), "ONE\ntwo\r\n");
  assert.equal(update("a\n", "@@\n-a"), "");
});

test("handles additions beyond JavaScript function argument limits", () => {
  const count = 150_000;
  const output = update("", `@@\n${Array(count).fill("+x").join("\n")}`);
  assert.equal(output, "x\n".repeat(count));
});
