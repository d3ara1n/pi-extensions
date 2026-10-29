import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPatch } from "../src/apply.ts";
import { MemoryFileSystem } from "./memory-fs.ts";
import { renderRejection } from "../src/report.ts";

async function rejection(source: string, expected: string[]): Promise<string> {
  const fs = new MemoryFileSystem({ a: source });
  const input = `*** Begin Patch\n*** Update File: a\n@@\n${expected.map((line) => `-${line}`).join("\n")}\n+new\n*** End Patch`;
  const error = await applyPatch(input, fs.context()).then(
    () => assert.fail("Expected an unmatched patch"),
    (error: Error) => error,
  );
  assert.equal(fs.writes.length, 0);
  assert.deepEqual(fs.snapshot(), { a: source });
  return error.message;
}

async function rejectionFor(source: string, input: string): Promise<string> {
  const fs = new MemoryFileSystem({ a: source });
  const error = await applyPatch(input, fs.context()).then(
    () => assert.fail("Expected an unmatched patch"),
    (error: Error) => error,
  );
  assert.equal(fs.writes.length, 0);
  assert.deepEqual(fs.snapshot(), { a: source });
  return error.message;
}

test("reports actual text, first difference, and complete adjacent whitespace run counts", async () => {
  const message = await rejection("const  x = 1;\n", ["const x = 1;"]);
  assert.ok(message.includes('expected: "const x = 1;"'));
  assert.ok(message.includes('actual:   "const  x = 1;"'));
  assert.doesNotMatch(message, /\\u0020/);
  assert.match(message, /column 7 \(Unicode code points\)/);
  assert.match(message, /expected SPACE \(U\+0020\) × 1 at column 6; actual SPACE \(U\+0020\) × 2 at column 6/);
});

test("exposes invisible code points without emitting raw control characters", async () => {
  const message = await rejection("😀al\u200B\u200Bpha\u202E\n", ["😀alpha"]);
  assert.match(message, /closest match at line 1/);
  assert.ok(message.includes("\\u200B\\u200B"));
  assert.ok(message.includes("\\u202E"));
  assert.match(message, /column 4 \(Unicode code points\)/);
  assert.match(message, /ZERO WIDTH SPACE \(U\+200B\) × 2/);
  assert.doesNotMatch(message, /[\u200B\u202E]/);
});

test("shows missing and extra blank source lines", async () => {
  const extra = await rejection("a\n\nb\n", ["a", "b"]);
  assert.match(extra, /blank-line alignment differs \(expected 2 lines, actual 3 lines\)/);
  assert.match(extra, /extra source line 2: ""/);
  const missing = await rejection("a\nb\n", ["a", "", "b"]);
  assert.match(missing, /missing source line for context line 2: ""/);
});

test("bounds diagnostic output around a late difference instead of hiding it", async () => {
  const prefix = "x".repeat(10_000);
  const message = await rejection(`${prefix}\u2060tail\n`, [`${prefix}tail`]);
  assert.match(message, /column 10001/);
  assert.ok(message.includes("\\u2060"));
  assert.match(message, /excerpt, columns/);
  assert.ok(message.length < 2_000);
});

test("bounds differing line examples and reports omitted differences", async () => {
  const expected = Array.from({ length: 8 }, (_, index) => `line${index} end`);
  const message = await rejection(expected.map((line) => line.replace(" ", "  ")).join("\n"), expected);
  assert.equal((message.match(/first difference at column/g) ?? []).length, 3);
  assert.match(message, /5 more differing lines omitted/);
});

test("identifies a context line copied from truncated output as a prefix of the source line", async () => {
  const line = "Use the shared display, page, section, body, caption, label, and code roles.";
  const message = await rejection(`intro\n${line}\n`, [line.slice(0, 40)]);
  assert.match(message, /closest match at line 2/);
  assert.match(message, /prefix of the source line, which continues for \d+ more code points; the context line looks truncated/);
});

test("does not treat short context lines as truncated prefixes", async () => {
  const message = await rejection("return value;\n", ["return"]);
  assert.doesNotMatch(message, /closest match/);
  assert.doesNotMatch(message, /looks truncated/);
});

test("reports every earlier exact match when an out-of-order hunk is ambiguous", async () => {
  const source = "A\nsame\nB\nA\nsame\nB\ntail\n";
  const patch = [
    "*** Begin Patch",
    "*** Update File: a",
    "@@",
    " B",
    " A",
    " same",
    "-B",
    "+B2",
    "@@",
    " A",
    "-same",
    "+CHANGED",
    "*** End Patch",
  ].join("\n");
  const message = await rejectionFor(source, patch);
  assert.match(message, /context matches at lines 1, 4 before the search start/);
  assert.match(message, /ambiguous/);
});

test("reports a single earlier exact match with the hunk-order hint", async () => {
  const source = "line1\nline2\nline3\nline4\nline5\n";
  const patch = [
    "*** Begin Patch",
    "*** Update File: a",
    "@@",
    " line4",
    "-line5",
    "+LINE5",
    "@@",
    " line2",
    "-line3",
    "+LINE3",
    "*** End Patch",
  ].join("\n");
  const message = await rejectionFor(source, patch);
  assert.match(
    message,
    /context matches at line 2, outside the searched range; move this hunk earlier/,
  );
  assert.doesNotMatch(message, /ambiguous/);
});

test("explains an EOF constraint without recommending hunk reordering", async () => {
  const message = await rejectionFor("target\ntail\n", [
    "*** Begin Patch", "*** Update File: a", "@@", "-target", "+changed",
    "*** End of File", "*** End Patch",
  ].join("\n"));
  assert.match(message, /check the \*\*\* End of File constraint/);
  assert.doesNotMatch(message, /move this hunk earlier/);
});

test("explains a matched anchor that excludes the context", async () => {
  const message = await rejectionFor("target\nanchor\ntail\n", [
    "*** Begin Patch", "*** Update File: a", "@@ anchor", "-target", "+changed",
    "*** End Patch",
  ].join("\n"));
  assert.match(message, /before the @@ anchor/);
  assert.doesNotMatch(message, /move this hunk earlier/);
});

test("retains the anchor boundary after its hunk fails to match", async () => {
  const message = await rejectionFor("target\nanchor\ntail\n", [
    "*** Begin Patch", "*** Update File: a", "@@ anchor", "-missing", "+changed",
    "@@", "-target", "+changed", "*** End Patch",
  ].join("\n"));
  assert.match(message, /hunk 2: context lines not found \(search started at line 3\)/);
  assert.match(message, /before the @@ anchor/);
  assert.doesNotMatch(message, /move this hunk earlier/);
});

test("searches a missing anchor from the cursor even when its hunk has an EOF marker", async () => {
  const message = await rejectionFor("anchor\nmiddle\ntail\n", [
    "*** Begin Patch", "*** Update File: a", "@@", "-middle", "+changed",
    "@@ anchor", "-tail", "+changed", "*** End of File", "*** End Patch",
  ].join("\n"));
  assert.match(message, /anchor "anchor" not found \(search started at line 3\)/);
  assert.match(message, /move this hunk earlier/);
  assert.doesNotMatch(message, /anchored to the end of the file/);
});

test("bounds ambiguous earlier matches and never recommends moving to an arbitrary occurrence", async () => {
  const message = await rejectionFor("same\n".repeat(8) + "tail\n", [
    "*** Begin Patch", "*** Update File: a", "@@", "-tail", "+changed",
    "@@", "-same", "+changed", "*** End Patch",
  ].join("\n"));
  assert.match(message, /lines 1, 2, 3, 4, 5, 6, … 2 more/);
  assert.match(message, /ambiguous.*add surrounding context/);
  assert.doesNotMatch(message, /move (this|the) hunk/);
});

test("omits the escape notice when the report contains no escape sequences", async () => {
  const message = await rejection("const x = 1;\n", ["const y = 1;"]);
  assert.doesNotMatch(message, /Quoted text uses diagnostic escapes/);
});

test("keeps the escape notice when the report contains an escaped code point", async () => {
  const message = await rejection("😀al\u200Bpha\n", ["😀alpha"]);
  assert.match(message, /Quoted text uses diagnostic escapes/);
});

test("does not mistake literal Unicode escape syntax for generated escapes", async () => {
  const message = await rejection("unrelated\n", [String.raw`const x = "\u1234\u{200B}";`]);
  assert.doesNotMatch(message, /Quoted text uses diagnostic escapes/);
});

test("does not infer diagnostic escapes from paths or filesystem errors", () => {
  const message = renderRejection({
    rejected: [{ path: String.raw`C:\u1234.txt`, kind: "delete", reason: String.raw`missing \u{200B}` }],
    verified: [String.raw`C:\u5678.txt`],
  });
  assert.doesNotMatch(message, /Quoted text uses diagnostic escapes/);
});

test("tracks supplementary Unicode escapes without leaking state between reports", async () => {
  const escaped = await rejection("unrelated\n", ["x\u{E0100}"]);
  assert.ok(escaped.includes("\\u{E0100}"));
  assert.match(escaped, /Quoted text uses diagnostic escapes/);
  const plain = await rejection("unrelated\n", ["plain"]);
  assert.doesNotMatch(plain, /Quoted text uses diagnostic escapes/);
});

test("omits the escape notice when the escaped character is outside the displayed excerpt", async () => {
  const message = await rejection("unrelated\n", ["x".repeat(100) + "\u200B"]);
  assert.match(message, /excerpt, columns/);
  assert.doesNotMatch(message, /Quoted text uses diagnostic escapes/);
});

test("includes the escape notice for a lone surrogate encoded by JSON", async () => {
  const message = await rejection("unrelated\n", ["x\uD800"]);
  assert.ok(message.includes("\\ud800"));
  assert.match(message, /Quoted text uses diagnostic escapes/);
});
