import * as assert from "node:assert/strict";
import { test } from "node:test";
import { TickScheduler } from "./tick.ts";

// Every test leaves an armed interval unless it unwinds its subscribers, so
// each one registers a stop() cleanup — an armed interval keeps the process
// alive and would hang the runner even after the assertions pass.
function makeScheduler(t: { after: (cb: () => void) => void }): TickScheduler {
  const scheduler = new TickScheduler();
  t.after(() => scheduler.stop());
  return scheduler;
}

test("first subscriber arms the interval, last one tears it down", (t) => {
  const scheduler = makeScheduler(t);
  assert.equal(scheduler.running, false);

  const offA = scheduler.subscribe(() => {});
  assert.equal(scheduler.running, true);

  const offB = scheduler.subscribe(() => {});
  assert.equal(scheduler.running, true);

  offA();
  assert.equal(scheduler.running, true);

  offB();
  assert.equal(scheduler.running, false);
});

test("tick fires every current subscriber exactly once", (t) => {
  const scheduler = makeScheduler(t);
  let hits = 0;
  const seen: number[] = [];
  scheduler.subscribe(() => hits++);
  scheduler.subscribe(() => seen.push(hits));

  scheduler.tick();

  assert.equal(hits, 1);
  assert.deepEqual(seen, [1]);
});

test("a callback unsubscribing during a tick does not break the iteration", (t) => {
  const scheduler = makeScheduler(t);
  const order: string[] = [];

  const off = scheduler.subscribe(() => {
    order.push("a");
    off();
  });
  scheduler.subscribe(() => order.push("b"));

  scheduler.tick();
  assert.deepEqual(order, ["a", "b"]);

  scheduler.tick();
  assert.deepEqual(order, ["a", "b", "b"]);
});

test("stop() drops every subscriber and disarms the interval", (t) => {
  const scheduler = makeScheduler(t);
  let hits = 0;
  scheduler.subscribe(() => hits++);
  scheduler.subscribe(() => hits++);
  assert.equal(scheduler.running, true);

  scheduler.stop();
  assert.equal(scheduler.running, false);

  scheduler.tick();
  assert.equal(hits, 0);
});

test("unsubscribe after stop() is a no-op", (t) => {
  const scheduler = makeScheduler(t);
  const off = scheduler.subscribe(() => {});
  scheduler.stop();
  off();
  assert.equal(scheduler.running, false);
});
