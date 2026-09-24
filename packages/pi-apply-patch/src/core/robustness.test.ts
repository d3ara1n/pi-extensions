import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch } from "./parser.ts";
import { applyUpdate, planUpdate } from "./update.ts";
import { countOccurrences, findCandidates } from "./diagnostics.ts";

function chunks(body: string) {
  const operation = parsePatch(`*** Begin Patch\n*** Update File: a\n${body}\n*** End Patch`).operations[0];
  assert.equal(operation.kind, "update");
  return operation.chunks;
}

function update(source: string, body: string): string {
  return applyUpdate(source, chunks(body), "a");
}

test("updates a BOM-prefixed first line with or without an explicit BOM in the patch", () => {
  for (const bom of ["", "\uFEFF"]) {
    assert.equal(update("\uFEFFold\r\nkeep\r\n", `@@\n-${bom}old\n+${bom}new`), "\uFEFFnew\r\nkeep\r\n");
  }
  assert.equal(update("\uFEFFold\nkeep\n", "@@\n-old"), "\uFEFFkeep\n");
  assert.equal(update("\uFEFFold\n", "@@\n-old"), "\uFEFF");
  assert.equal(update("\uFEFF", "@@\n+new"), "\uFEFFnew\n");
  assert.equal(update("\uFEFFhead\nold\n", "@@ head\n-old\n+new"), "\uFEFFhead\nnew\n");
  assert.equal(countOccurrences(["\uFEFFsame", "same"], ["same"], 0), 2);
});

test("does not ignore BOMs or zero-width characters inside source content", () => {
  for (const source of ["first\n\uFEFFold\n", "o\u200Bld\n", "o\u2060ld\n"]) {
    assert.throws(() => update(source, "@@\n-old\n+new"), /Failed to find expected lines/);
  }
});

test("diagnostics treat a leading BOM consistently with matching", () => {
  const plan = planUpdate("\uFEFFx\nz\n", chunks("@@\n-x\n+X\n@@\n-x\n+Y"));
  const second = plan.outcomes[1];
  assert.equal(second.status, "unmatched");
  assert.deepEqual(second.failure.candidates, [
    { line: 1, differing: 0, whitespace: 0, difference: "exact", beforeSearchStart: true },
  ]);
  const blank = findCandidates(["\uFEFFa", "", "b"], ["a", "b"], 0)[0];
  assert.equal(blank.differing, 1);
  assert.deepEqual(blank.details, [{ actualLine: 2, actual: "" }]);
});

test("preserves context spelling and mixed LF/CRLF endings across multiple chunks", () => {
  const source = "\uFEFF\tsection  \r\nold\n\tkeep\r\n\nlast\r\n";
  const body = "@@\n section\n-old\n+new\n keep\n@@\n-last\n+LAST";
  assert.equal(update(source, body), "\uFEFF\tsection  \r\nnew\n\tkeep\r\n\nLAST\r\n");
  assert.equal(update("“keep”\r\nold\r\n", '@@\n "keep"\n-old\n+new'), "“keep”\r\nnew\r\n");
});

test("insertions inherit adjacent endings and replacements inherit removed-line endings", () => {
  assert.equal(update("head\r\ntail\n", "@@\n head\n+middle\n tail"), "head\r\nmiddle\r\ntail\n");
  assert.equal(update("a\r\nb\nc\r\n", "@@\n-a\n-b\n+A\n+B\n+extra\n c"), "A\r\nB\nextra\nc\r\n");
  assert.equal(update("a\r\n", "@@\n+tail"), "a\r\ntail\r\n");
  assert.equal(update("a", "@@\n-a\n+b"), "b\n");
  assert.equal(update("a\n\n", "@@\n-a\n+A"), "A\n\n");
});

test("diagnostic Unicode folding locates candidates without allowing writes", () => {
  for (const [actual, expected] of [
    ["al\u200Bpha", "alpha"],
    ["al\u2060pha", "alpha"],
    ["al\u202Epha", "alpha"],
    ["cafe\u0301", "caf\u00E9"],
    ["const\tx = 1;", "const x = 1;"],
  ]) {
    const plan = planUpdate(`${actual}\n`, chunks(`@@\n-${expected}\n+new`));
    assert.equal(plan.outcomes[0].status, "unmatched");
    const candidates = findCandidates([actual], [expected], 0);
    assert.equal(candidates[0]?.line, 1);
    assert.equal(candidates[0]?.details?.[0].actual, actual);
  }
});

test("diagnostic blank-line alignment handles added, missing, and relocated blank lines", () => {
  const cases = [
    { actual: ["a", "", "", "b"], expected: ["a", "b"], counts: [2, 4], differences: 2 },
    { actual: ["a", "b"], expected: ["a", "", "b"], counts: [3, 2], differences: 1 },
    { actual: ["a", "", "b", "c"], expected: ["a", "b", "", "c"], counts: [4, 4], differences: 2 },
  ];
  for (const { actual, expected, counts, differences } of cases) {
    const candidate = findCandidates(actual, expected, 0)[0];
    assert.deepEqual(candidate?.lineCount, { expected: counts[0], actual: counts[1] });
    assert.equal(candidate.differing, differences);
    assert.throws(() => update(`${actual.join("\n")}\n`, `@@\n${expected.map((line) => `-${line}`).join("\n")}\n+new`));
  }
  assert.deepEqual(findCandidates(["a", "", "b"], ["a", "c"], 0)[0]?.lineCount, undefined);
});
