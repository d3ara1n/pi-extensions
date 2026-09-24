import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPatch } from "../src/apply.ts";
import { MemoryFileSystem } from "./memory-fs.ts";

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

test("reports actual text, first difference, and complete adjacent whitespace run counts", async () => {
  const message = await rejection("const  x = 1;\n", ["const x = 1;"]);
  assert.ok(message.includes('expected: "const\\u0020x\\u0020=\\u00201;"'));
  assert.ok(message.includes('actual:   "const\\u0020\\u0020x\\u0020=\\u00201;"'));
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
