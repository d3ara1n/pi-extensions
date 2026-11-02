import * as assert from "node:assert/strict";
import { test } from "node:test";
import { cacheHitRateToken, cacheReadToken } from "./index.ts";
import { collectSessionStats } from "./stats.ts";

test("cache-read color follows the latest reading, independently of session totals", () => {
  assert.equal(cacheReadToken(0), "error");
  assert.equal(cacheReadToken(1), "muted");
  assert.equal(cacheReadToken(40_000), "muted");
});

test("hit-rate color uses the unrounded 50% and 90% thresholds", () => {
  assert.equal(cacheHitRateToken(0), "error");
  assert.equal(cacheHitRateToken(49.99), "error");
  assert.equal(cacheHitRateToken(50), "warning");
  assert.equal(cacheHitRateToken(89.99), "warning");
  assert.equal(cacheHitRateToken(90), "muted");
  assert.equal(cacheHitRateToken(100), "muted");
});

test("session cost includes non-message usage without counting unrelated entries", () => {
  const entries = [
    { type: "message", message: { role: "assistant", usage: { cost: { total: 4 } } } },
    { type: "message", message: { role: "toolResult", usage: { cost: { total: 2 } } } },
    { type: "usage", kind: "cache_warm", usage: { cost: { total: 1 } } },
    { type: "usage", kind: "future_kind", usage: { cost: { total: 3 } } },
    { type: "compaction", usage: { cost: { total: 5 } } },
    { type: "branch_summary", usage: { cost: { total: 6 } } },
    { type: "message", message: { role: "user", usage: { cost: { total: 90 } } } },
    { type: "custom", usage: { cost: { total: 90 } } },
    { type: "usage", usage: { cost: { total: Number.NaN } } },
  ];

  assert.equal(
    collectSessionStats(entries.map((entry, i) => ({
      ...entry,
      id: String(i),
      parentId: i === 0 ? null : String(i - 1),
    })), String(entries.length - 1)).cost,
    21,
  );
});
