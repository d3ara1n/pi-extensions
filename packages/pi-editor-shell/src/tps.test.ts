import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateResponsePerformance,
  type ResponsePerformanceSample,
} from "./tps.ts";

function sample(overrides: Partial<ResponsePerformanceSample> = {}): ResponsePerformanceSample {
  return {
    outputTokens: 101,
    reasoningTokens: 20,
    reasoningExpected: true,
    turnStartedAt: 1_000,
    firstVisibleTextAt: 3_000,
    responseEndedAt: 7_000,
    hasVisibleText: true,
    hasToolCall: false,
    stopReason: "stop",
    ...overrides,
  };
}

test("calculates wait, end-to-end throughput, and generation throughput", () => {
  assert.deepEqual(calculateResponsePerformance(sample()), {
    waitMs: 2_000,
    totalMs: 6_000,
    generationMs: 4_000,
    visibleTokens: 81,
    e2eTps: 13.5,
    generationTps: 20,
    tokenSource: "provider-output-minus-reasoning",
  });
});

test("uses provider output when reasoning is not expected", () => {
  const result = calculateResponsePerformance(sample({
    outputTokens: 51,
    reasoningTokens: undefined,
    reasoningExpected: false,
    firstVisibleTextAt: 2_000,
    responseEndedAt: 6_000,
  }));
  assert.equal(result.visibleTokens, 51);
  assert.equal(result.e2eTps, 10.2);
  assert.equal(result.generationTps, 12.5);
  assert.equal(result.tokenSource, "provider-output");
});

test("rejects throughput when expected reasoning usage is missing or ambiguous", () => {
  for (const reasoningTokens of [undefined, 0]) {
    const result = calculateResponsePerformance(sample({ reasoningTokens }));
    assert.equal(result.waitMs, 2_000);
    assert.equal(result.totalMs, 6_000);
    assert.equal(result.e2eTps, undefined);
    assert.equal(result.generationTps, undefined);
    assert.equal(
      result.throughputUnavailableReason,
      "provider omitted usable reasoning-token usage",
    );
  }
});

test("rejects throughput for responses containing tool calls", () => {
  const result = calculateResponsePerformance(sample({ hasToolCall: true }));
  assert.equal(result.waitMs, 2_000);
  assert.equal(result.e2eTps, undefined);
  assert.equal(result.throughputUnavailableReason, "text and tool-call tokens are not separable");
});

test("rejects throughput for failed and aborted responses", () => {
  for (const stopReason of ["error", "aborted"]) {
    const result = calculateResponsePerformance(sample({ stopReason }));
    assert.equal(result.e2eTps, undefined);
    assert.equal(result.throughputUnavailableReason, "response failed or was aborted");
  }
});

test("rejects throughput when there is no visible text", () => {
  const result = calculateResponsePerformance(sample({ hasVisibleText: false }));
  assert.equal(result.e2eTps, undefined);
  assert.equal(result.throughputUnavailableReason, "response contained no visible text");
});

test("keeps end-to-end throughput when the generation sample is too small", () => {
  const result = calculateResponsePerformance(sample({
    outputTokens: 9,
    reasoningTokens: 0,
    firstVisibleTextAt: 6_800,
  }));
  assert.equal(result.e2eTps, 1.5);
  assert.equal(result.generationTps, undefined);
  assert.equal(result.generationUnavailableReason, "fewer than 10 visible tokens");
});

test("rejects a generation sample shorter than 250 ms", () => {
  const result = calculateResponsePerformance(sample({
    outputTokens: 10,
    reasoningTokens: 0,
    firstVisibleTextAt: 6_751,
  }));
  assert.equal(result.e2eTps, 10 / 6);
  assert.equal(result.generationTps, undefined);
  assert.equal(result.generationUnavailableReason, "visible generation lasted less than 250 ms");
});

test("represents non-streaming output as full wait with unavailable generation throughput", () => {
  const result = calculateResponsePerformance(sample({
    outputTokens: 50,
    reasoningTokens: 0,
    firstVisibleTextAt: 7_000,
  }));
  assert.equal(result.waitMs, 6_000);
  assert.equal(result.totalMs, 6_000);
  assert.equal(result.e2eTps, 50 / 6);
  assert.equal(result.generationTps, undefined);
  assert.equal(result.generationUnavailableReason, "visible generation lasted less than 250 ms");
});

test("rejects invalid provider usage", () => {
  assert.equal(
    calculateResponsePerformance(sample({ outputTokens: undefined })).throughputUnavailableReason,
    "provider output-token usage is unavailable",
  );
  assert.equal(
    calculateResponsePerformance(sample({ reasoningTokens: 102 })).throughputUnavailableReason,
    "provider reasoning-token usage is invalid",
  );
});

test("rejects invalid timing without manufacturing rates", () => {
  const result = calculateResponsePerformance(sample({ responseEndedAt: 500 }));
  assert.equal(result.waitMs, undefined);
  assert.equal(result.totalMs, undefined);
  assert.equal(result.e2eTps, undefined);
  assert.equal(result.throughputUnavailableReason, "end-to-end timing data is unavailable");
});
