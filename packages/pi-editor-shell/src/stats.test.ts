import * as assert from "node:assert/strict";
import { test } from "node:test";
import { collectSessionStats, SessionStatsCache } from "./stats.ts";

test("one snapshot combines session usage with counts restricted to the selected branch", () => {
  const firstUsage = { input: 20, cacheRead: 80, cacheWrite: 10, cost: { total: 1 } };
  const latestUsage = { input: 30, cacheRead: 120, cacheWrite: 5, cost: { total: 2 } };
  const entries = [
    { id: "u1", parentId: null, type: "message", message: { role: "user" } },
    { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", usage: firstUsage } },
    { id: "old-user", parentId: "a1", type: "message", message: { role: "user" } },
    { id: "old-compact", parentId: "old-user", type: "compaction" },
    { id: "u2", parentId: "a1", type: "message", message: { role: "user" } },
    { id: "a2", parentId: "u2", type: "message", message: { role: "assistant", usage: latestUsage } },
    { id: "tool", parentId: "a2", type: "message", message: {
      role: "toolResult", usage: { input: 900, cacheRead: 900, cost: { total: 4 } },
    } },
    { id: "compact", parentId: "tool", type: "compaction", usage: { cost: { total: 8 } } },
    { id: "custom", parentId: "compact", type: "custom_message", message: { role: "user" } },
  ];

  assert.deepEqual(collectSessionStats(entries, "custom"), {
    input: 50, cacheRead: 200, cacheWrite: 15, cost: 15,
    latestUsage, userMessages: 2, compactions: 1,
  });
  const rewound = collectSessionStats(entries, "a1");
  assert.equal(rewound.userMessages, 1);
  assert.equal(rewound.compactions, 0);
  assert.equal(rewound.cost, 15);
  assert.equal(rewound.cacheRead, 200);
  assert.equal(collectSessionStats(entries, null).userMessages, 0);
});

test("completed request usage becomes visible after persistence without waiting for tools or turn_end", () => {
  const cache = new SessionStatsCache();
  const entries: Parameters<typeof collectSessionStats>[0][number][] = [];
  let leafId: string | null = null;
  let reads = 0;
  const source = {
    getEntries: () => { reads++; return entries; },
    getLeafId: () => leafId,
  };
  const empty = cache.read(source);
  assert.equal(empty.cost, 0);

  // A message_end repaint may run before persistence; it must not freeze
  // the old snapshot once the finalized assistant message is appended.
  assert.equal(cache.read(source), empty);
  entries.push({
    id: "response", parentId: null, type: "message",
    message: { role: "assistant", usage: { cacheRead: 100, cost: { total: 2 } } },
  });
  leafId = "response";
  const response = cache.read(source);
  assert.equal(response.cacheRead, 100);
  assert.equal(response.latestUsage?.cacheRead, 100);
  assert.equal(response.cost, 2);
  assert.equal(cache.read(source), response);
  assert.equal(reads, 2);

  entries.push({
    id: "tool", parentId: "response", type: "message",
    message: { role: "toolResult", usage: { cost: { total: 3 } } },
  });
  leafId = "tool";
  const completed = cache.read(source);
  assert.equal(completed.cost, 5);
  assert.equal(completed.cacheRead, 100);
  assert.equal(cache.read(source), completed);
  assert.equal(reads, 3);

  leafId = "response";
  assert.equal(cache.read(source).cost, 5);
  assert.equal(reads, 4);
});
