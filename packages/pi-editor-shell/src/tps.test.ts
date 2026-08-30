import assert from "node:assert/strict";
import test from "node:test";
import { calculateVisibleTextTps, type VisibleTextTpsSample } from "./tps.ts";

function sample(overrides: Partial<VisibleTextTpsSample> = {}): VisibleTextTpsSample {
  return {
    outputTokens: 51,
    reasoningTokens: 10,
    firstTextDeltaAt: 1_000,
    lastTextDeltaAt: 5_000,
    hasToolCall: false,
    stopReason: "stop",
    ...overrides,
  };
}

test("calculates visible text TPS over inter-token intervals", () => {
  assert.equal(calculateVisibleTextTps(sample()), 10);
});

test("uses all output tokens when the provider has no reasoning breakdown", () => {
  assert.equal(calculateVisibleTextTps(sample({ reasoningTokens: undefined })), 12.5);
});

test("accepts the minimum reliable sample", () => {
  assert.equal(
    calculateVisibleTextTps(sample({
      outputTokens: 10,
      reasoningTokens: 0,
      firstTextDeltaAt: 1_000,
      lastTextDeltaAt: 1_250,
    })),
    36,
  );
});

test("rejects responses containing tool calls", () => {
  assert.equal(calculateVisibleTextTps(sample({ hasToolCall: true })), undefined);
});

test("rejects failed and aborted responses", () => {
  assert.equal(calculateVisibleTextTps(sample({ stopReason: "error" })), undefined);
  assert.equal(calculateVisibleTextTps(sample({ stopReason: "aborted" })), undefined);
});

test("rejects samples with too few visible tokens", () => {
  assert.equal(
    calculateVisibleTextTps(sample({ outputTokens: 18, reasoningTokens: 9 })),
    undefined,
  );
});

test("rejects samples shorter than 250 ms", () => {
  assert.equal(
    calculateVisibleTextTps(sample({ firstTextDeltaAt: 1_000, lastTextDeltaAt: 1_249 })),
    undefined,
  );
});

test("rejects missing or invalid usage and timing data", () => {
  assert.equal(calculateVisibleTextTps(sample({ outputTokens: undefined })), undefined);
  assert.equal(calculateVisibleTextTps(sample({ firstTextDeltaAt: undefined })), undefined);
  assert.equal(calculateVisibleTextTps(sample({ lastTextDeltaAt: undefined })), undefined);
  assert.equal(calculateVisibleTextTps(sample({ reasoningTokens: -1 })), undefined);
  assert.equal(calculateVisibleTextTps(sample({ lastTextDeltaAt: Number.NaN })), undefined);
});
