import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatIdleMinutes,
  formatIdleTimerLabel,
  idleTimerToken,
  lastActivityFromEntries,
  promptCacheTtlMs,
} from "./timer.ts";

const MIN = 60_000;

test("formatIdleMinutes floors to whole minutes", () => {
  assert.equal(formatIdleMinutes(0), "0m");
  assert.equal(formatIdleMinutes(59_999), "0m");
  assert.equal(formatIdleMinutes(MIN), "1m");
  // 4:59 reads as 4m — the user-facing spec.
  assert.equal(formatIdleMinutes(4 * MIN + 59_999), "4m");
  assert.equal(formatIdleMinutes(5 * MIN), "5m");
  assert.equal(formatIdleMinutes(63 * MIN), "63m");
});

test("formatIdleMinutes clamps negative and non-finite input to 0m", () => {
  assert.equal(formatIdleMinutes(-MIN), "0m");
  assert.equal(formatIdleMinutes(Number.NaN), "0m");
  assert.equal(formatIdleMinutes(Number.POSITIVE_INFINITY), "0m");
});

test("formatIdleTimerLabel shows an ellipsis while the agent is active", () => {
  assert.equal(formatIdleTimerLabel(0, true), "…");
  assert.equal(formatIdleTimerLabel(5 * MIN, true), "…");
  assert.equal(formatIdleTimerLabel(0, false), "0m");
  assert.equal(formatIdleTimerLabel(5 * MIN, false), "5m");
});

test("idleTimerToken stays muted while fresh and when the TTL is unknown", () => {
  const ttl = 5 * MIN;
  assert.equal(idleTimerToken(0, ttl), "muted");
  assert.equal(idleTimerToken(4 * MIN + 29_999, ttl), "muted");
  // Unknown (or non-positive) TTL means "assume not expired" — forever.
  assert.equal(idleTimerToken(6 * 60 * MIN, undefined), "muted");
  assert.equal(idleTimerToken(6 * 60 * MIN, 0), "muted");
  assert.equal(idleTimerToken(6 * 60 * MIN, -1), "muted");
});

test("idleTimerToken turns amber at 90% of the TTL and red at the TTL", () => {
  const ttl = 5 * MIN;
  assert.equal(idleTimerToken(4 * MIN + 30_000, ttl), "warning");
  assert.equal(idleTimerToken(4 * MIN + 59_999, ttl), "warning");
  assert.equal(idleTimerToken(5 * MIN, ttl), "error");
  assert.equal(idleTimerToken(60 * MIN, ttl), "error");
});

test("promptCacheTtlMs picks the tier from the retention string", () => {
  const model = { promptCache: { short: 300, long: 3600 } };

  assert.equal(promptCacheTtlMs(model, undefined), 300_000);
  assert.equal(promptCacheTtlMs(model, "short"), 300_000);
  assert.equal(promptCacheTtlMs(model, "garbage"), 300_000);
  assert.equal(promptCacheTtlMs(model, "long"), 3_600_000);
});

test("promptCacheTtlMs returns undefined without a declared lifetime", () => {
  assert.equal(promptCacheTtlMs(undefined, undefined), undefined);
  assert.equal(promptCacheTtlMs({}, "long"), undefined);
  assert.equal(promptCacheTtlMs({ promptCache: { short: 300 } }, "long"), undefined);
  assert.equal(promptCacheTtlMs({ promptCache: { short: 0 } }, "short"), undefined);
});

test("lastActivityFromEntries scans newest-first for a parseable timestamp", () => {
  const now = 1_700_000_000_000;
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  assert.equal(lastActivityFromEntries([], now), now);
  // Entries without a timestamp fall through to the next candidate.
  assert.equal(
    lastActivityFromEntries([{ timestamp: iso(-2 * MIN) }, { timestamp: undefined }, {}], now),
    now - 2 * MIN,
  );
  // Unparseable strings are skipped, newest valid timestamp wins.
  assert.equal(
    lastActivityFromEntries([
      { timestamp: iso(-5 * MIN) },
      { timestamp: "not a date" },
      { timestamp: iso(-3 * MIN) },
    ], now),
    now - 3 * MIN,
  );
});
