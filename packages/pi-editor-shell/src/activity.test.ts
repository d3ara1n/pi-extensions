import * as assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ActivityIndicator,
  formatIdleMinutes,
  idleTimerToken,
  lastActivityFromEntries,
  promptCacheTtlMs,
} from "./activity.ts";

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

test("idleTimerToken stays muted while fresh and when the TTL is unknown", () => {
  const ttl = 5 * MIN;
  assert.equal(idleTimerToken(0, ttl), "muted");
  assert.equal(idleTimerToken(4 * MIN + 29_999, ttl), "muted");
  // Unknown (or non-positive) TTL means "assume not expired" — forever.
  assert.equal(idleTimerToken(6 * 60 * MIN, undefined), "muted");
  assert.equal(idleTimerToken(6 * 60 * MIN, 0), "muted");
  assert.equal(idleTimerToken(6 * 60 * MIN, -1), "muted");
  // Unarmed anchor never indicates.
  assert.equal(idleTimerToken(undefined, ttl), "muted");
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

test("lastActivityFromEntries anchors only on conversational entries", () => {
  const now = 1_700_000_000_000;
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  // Nothing conversational — empty or bootstrap-only — leaves the timer
  // unarmed: a fresh session starts with session/model_change/
  // thinking_level_change entries, but no prompt has been sent yet.
  assert.equal(lastActivityFromEntries([]), undefined);
  assert.equal(
    lastActivityFromEntries([
      { type: "session", timestamp: iso(0) },
      { type: "model_change", timestamp: iso(0) },
      { type: "thinking_level_change", timestamp: iso(0) },
    ]),
    undefined,
  );
  // Bookkeeping entries between messages are skipped; the newest
  // conversational timestamp wins.
  assert.equal(
    lastActivityFromEntries([
      { type: "message", timestamp: iso(-5 * MIN) },
      { type: "model_change", timestamp: iso(-4 * MIN) },
      { type: "custom_message", timestamp: iso(-3 * MIN) },
      { type: "usage", timestamp: iso(-1 * MIN) },
    ]),
    now - 3 * MIN,
  );
  // Conversational entries with missing or unparseable timestamps fall
  // through to older candidates.
  assert.equal(
    lastActivityFromEntries([
      { type: "message", timestamp: iso(-5 * MIN) },
      { type: "custom_message", timestamp: "not a date" },
      { type: "message", timestamp: undefined },
    ]),
    now - 5 * MIN,
  );
});

// The contract is one fast animation clock while busy, a slow change check
// while idle, and no callbacks after shutdown. Fake time exercises these
// boundaries without rendering a terminal or leaving live intervals behind.
function makeActivity(t: TestContext, lastActivityAt?: number) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_700_000_000_000 });
  const paints: ReturnType<ActivityIndicator["read"]>[] = [];
  let ttl: number | undefined = 5 * MIN;
  const activity = new ActivityIndicator(
    () => paints.push(activity.read()),
    () => ttl,
    lastActivityAt,
  );
  t.after(() => activity.stop());
  return { activity, paints, setTtl: (value: number | undefined) => { ttl = value; } };
}

test("a fresh session stays hidden until a run, then starts idle time at settlement", (t) => {
  const { activity, paints } = makeActivity(t);
  assert.deepEqual(activity.read(), { kind: "hidden" });
  t.mock.timers.tick(MIN);
  assert.equal(paints.length, 0);

  activity.setPhase("exec");
  assert.deepEqual(activity.read(), { kind: "busy", glyph: "◜" });
  t.mock.timers.tick(100);
  assert.deepEqual(activity.read(), { kind: "busy", glyph: "◝" });
  // Even a run lasting longer than the cache TTL remains busy.
  t.mock.timers.tick(6 * MIN);
  assert.equal(activity.read().kind, "busy");
  activity.settle();
  assert.deepEqual(activity.read(), { kind: "idle", label: "0m", token: "muted" });
  paints.length = 0;
  t.mock.timers.tick(59_000);
  assert.equal(paints.length, 0);
  t.mock.timers.tick(1_000);
  assert.deepEqual(paints, [{ kind: "idle", label: "1m", token: "muted" }]);
});

test("repeated phase events preserve animation timing and phase transitions restart frames", (t) => {
  const { activity, paints } = makeActivity(t);
  activity.setPhase("exec");
  t.mock.timers.tick(100);
  t.mock.timers.tick(50);
  activity.setPhase("exec");
  const count = paints.length;
  t.mock.timers.tick(50);
  assert.equal(paints.length, count + 1);
  assert.deepEqual(activity.read(), { kind: "busy", glyph: "◞" });

  activity.setPhase("outputting");
  assert.deepEqual(activity.read(), { kind: "busy", glyph: "⡀" });
  t.mock.timers.tick(100);
  assert.deepEqual(activity.read(), { kind: "busy", glyph: "⣀" });
  activity.setPhase("thinking");
  const thinkingPaints = paints.length;
  t.mock.timers.tick(100);
  assert.equal(paints.length, thinkingPaints);
  t.mock.timers.tick(100);
  assert.deepEqual(activity.read(), { kind: "busy", glyph: "○" });
});

test("restored idle time repaints on TTL transitions even within the same minute", (t) => {
  const { activity, paints, setTtl } = makeActivity(t, 1_700_000_000_000 - 269_000);
  assert.deepEqual(activity.read(), { kind: "idle", label: "4m", token: "muted" });
  t.mock.timers.tick(1_000);
  assert.deepEqual(paints, [{ kind: "idle", label: "4m", token: "warning" }]);
  t.mock.timers.tick(30_000);
  assert.deepEqual(activity.read(), { kind: "idle", label: "5m", token: "error" });
  setTtl(undefined);
  t.mock.timers.tick(1_000);
  assert.deepEqual(paints.at(-1), { kind: "idle", label: "5m", token: "muted" });
});

test("resuming replaces the idle clock and settling starts a fresh interval", (t) => {
  const { activity, paints } = makeActivity(t, 1_700_000_000_000 - 5 * MIN);
  activity.read();
  t.mock.timers.tick(500);
  activity.setPhase("toolcall");
  t.mock.timers.tick(100);
  assert.deepEqual(activity.read(), { kind: "busy", glyph: "▒" });
  activity.settle();
  assert.deepEqual(activity.read(), { kind: "idle", label: "0m", token: "muted" });
  paints.length = 0;
  t.mock.timers.tick(30_000);
  activity.settle();
  t.mock.timers.tick(30_000);
  assert.deepEqual(paints, [{ kind: "idle", label: "1m", token: "muted" }]);
});

test("shutdown stops animation and idle checks, including repeated cleanup", (t) => {
  const { activity, paints } = makeActivity(t);
  activity.setPhase("exec");
  activity.stop();
  activity.stop();
  paints.length = 0;
  t.mock.timers.tick(MIN);
  assert.equal(paints.length, 0);
});

test("shutdown stops a restored session's idle clock", (t) => {
  const { activity, paints } = makeActivity(t, 1_700_000_000_000);
  activity.read();
  activity.stop();
  t.mock.timers.tick(6 * MIN);
  assert.equal(paints.length, 0);
});
