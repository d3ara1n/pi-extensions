import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePatchInput } from "./normalize.ts";
import { parsePatch } from "./parser.ts";

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
function normalize(input: string) {
  const result = normalizePatchInput(input);
  const again = normalizePatchInput(result.input);
  assert.equal(again.input, result.input, "Normalization must be idempotent");
  assert.deepEqual(again.notices, [], "Canonical input must not emit further repairs");
  return result;
}
function parse(input: string) {
  const normalized = normalize(input);
  return parsePatch(normalized.input, normalized.sourceLines);
}

test("canonical patches retain their text and emit no repairs", () => {
  const input = patch(
    "*** Add File: a\n+literal  \n+\n*** Update File: b\n@@ anchor\n old\n-new\n+NEW\n*** End of File\n*** Delete File: c",
  );
  assert.equal(normalize(input).input, input);
  assert.deepEqual(normalize(input).notices, []);
});

test("repairs missing Add prefixes without stripping content whitespace or existing prefixes", () => {
  const input = patch(
    "*** Add File: a\nfirst\n\n  indented  \n+already\n++literal plus\n*** Delete File: b",
  );
  const result = normalize(input);
  assert.equal(
    result.input,
    patch(
      "*** Add File: a\n+first\n+\n+  indented  \n+already\n++literal plus\n*** Delete File: b",
    ),
  );
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].code, "add-prefix");
  assert.equal(result.notices[0].count, 3);
  assert.equal(result.notices[0].line, 3);
  assert.deepEqual(parse(input).operations[0], {
    kind: "add",
    path: "a",
    content: "first\n\n  indented  \nalready\n+literal plus\n",
  });
});

test("repairs anchor separators only in Update structural positions", () => {
  const result = normalize(
    patch("*** Update File: a\n@@function f() {\n-@@old\n+@@new\n @@literal context"),
  );
  assert.equal(result.notices[0].code, "anchor-space");
  assert.equal(
    result.input,
    patch("*** Update File: a\n@@ function f() {\n-@@old\n+@@new\n @@literal context"),
  );
  const tab = normalize(patch("*** Update File: a\n@@\tanchor\n-x\n+y"));
  assert.ok(tab.input.includes("@@ \tanchor"), "Anchor content is literal, not trimmed");
});

test("removes only empty Update blocks without Move or explicit hunks", () => {
  const result = normalize(
    patch("*** Update File: skipped\n*** Add File: a\n+x\n*** Update File: also-skipped"),
  );
  assert.equal(result.input, patch("*** Add File: a\n+x"));
  assert.deepEqual(
    result.notices.map((notice) => notice.code),
    ["empty-update", "empty-update"],
  );
  assert.match(result.notices[0].message, /that block made no changes/);
  for (const body of ["@@", "*** Move to: b", "@@\n@@"]) {
    assert.throws(() => parse(patch(`*** Update File: a\n${body}`)), /invalid hunk/);
  }
  assert.deepEqual(parse(patch("*** Update File: skipped")).operations, []);
});

test("unwraps only complete matching Markdown fences and legacy heredocs", () => {
  for (const [open, close] of [
    ["```diff", "```"],
    ["~~~~patch", "~~~~~"],
    ["<<EOF", "EOF"],
    ["<<'EOF'", "EOF"],
    ['<<"EOF"', "EOF"],
  ]) {
    const inner = patch("*** Add File: a\n+x");
    const result = normalize(`${open}\n${inner}\n${close}`);
    assert.equal(result.input, inner);
    assert.equal(result.notices.length, 1);
  }
  for (const input of [
    `intro\n\`\`\`\n${patch("*** Add File: a\n+x")}\n\`\`\``,
    `\`\`\`\n${patch("*** Add File: a\n+x")}\n~~~`,
    "```\n*** Begin Patch\n*** Add File: a\npartial\n```",
    "*** Begin Patch\n*** Add File: a\npartial",
  ]) {
    const result = normalizePatchInput(input);
    assert.equal(result.input, input);
    assert.deepEqual(result.notices, []);
    assert.throws(() => parsePatch(result.input));
  }
});

test("numeric hunks require context or removed lines and preserve all body text", () => {
  for (const header of ["@@ -1,2 +1,2 @@", "@@ -1 +1 @@ section", "@@ -0,0 +1 @@", "@@-1 +1 @@"]) {
    const input = patch(`*** Update File: a\n${header}\n-old\n+new`);
    assert.equal(normalize(input).input, patch("*** Update File: a\n@@\n-old\n+new"));
    assert.ok(normalize(input).notices.some((notice) => notice.code === "numeric-hunk"));
  }
  const pureAdd = patch("*** Update File: a\n@@ -1 +1 @@\n+new\n@@\n-old\n+OLD");
  assert.equal(normalize(pureAdd).input, pureAdd, "Do not borrow old content from a later hunk");
  assert.deepEqual(normalize(pureAdd).notices, []);
  const context = patch("*** Update File: a\n@@ -1 +1 @@\n keep\n+new\n*** End of File");
  assert.ok(normalize(context).input.includes("\n@@\n keep\n+new\n*** End of File"));
});

test("numeric-header lookahead preserves leading context prefixes on patch markers", () => {
  const input = patch("*** Update File: a\n@@ -1 +1,2 @@\n *** End Patch\n+new");
  assert.equal(normalize(input).input, patch("*** Update File: a\n@@\n *** End Patch\n+new"));
});

test("legacy marker padding, implicit hunks, and blank context have one explicit normalization path", () => {
  const input =
    "<<EOF\n *** Begin Patch \n  *** Update File: a \n-a  \n+A  \n\n b\n*** End of File  \n\n *** End Patch \nEOF";
  const result = normalize(input);
  assert.equal(result.input, patch("*** Update File: a\n@@\n-a  \n+A  \n \n b\n*** End of File"));
  assert.deepEqual(
    result.notices.map((notice) => notice.code),
    [
      "heredoc-wrapper",
      "marker-whitespace",
      "marker-whitespace",
      "implicit-hunk",
      "blank-context",
      "eof-padding",
    ],
  );
  assert.equal(parse(input).operations.length, 1);
});

test("preserves the legacy extra final End marker without consuming literal context", () => {
  const input = patch("*** Add File: a\n+x");
  assert.equal(normalize(`${input}\n\n*** End Patch`).input, input);
  assert.equal(normalize(`${input}\n*** End Patch`).notices[0].code, "duplicate-end");
  assert.throws(() => parse(`${input}\n*** End Patch\n*** End Patch`), /last line/);
  const literal = patch("*** Update File: a\n@@\n *** End Patch");
  assert.equal(normalize(literal).input, literal);
  assert.deepEqual(normalize(literal).notices, []);
});

test("normalization never guesses Update prefixes, hides unknown markers, or repairs truncation", () => {
  for (const body of [
    "*** Add File: a\n*** Unknown File: b",
    "*** Add File: a\n*** End Patc",
    "*** Update File: a\n@@\nmissing-prefix",
    "*** Update File: a\n@@\n-old\n+new\n*** End of File\n+late",
    "*** Environment ID: remote\n*** Add File: a\n+x",
  ])
    assert.throws(() => parse(patch(body)));
});

test("source mapping reports original lines after wrappers, removals, and insertions", () => {
  const input = `\n\n\`\`\`patch\n${patch("*** Update File: skipped\n*** Update File: a\n-old\n+new\ninvalid")}\n\`\`\``;
  const result = normalize(input);
  assert.throws(() => parsePatch(result.input, result.sourceLines), /invalid hunk at line 9/);
  assert.equal(result.notices.find((notice) => notice.code === "empty-update")?.line, 5);
});

test("the canonical parser does not independently repair format variations", () => {
  for (const input of [
    `\`\`\`\n${patch("*** Add File: a\n+x")}\n\`\`\``,
    patch("*** Add File: a\nmissing-prefix"),
    patch("*** Update File: a\n@@anchor\n-old\n+new"),
    patch("*** Update File: a\n-old\n+new"),
    patch("*** Update File: a\n@@\n-old\n+new\n"),
    patch("*** Update File: a"),
    `${patch("*** Add File: a\n+x")}\n*** End Patch`,
  ])
    assert.throws(() => parsePatch(input));
});
