/**
 * Regression test for retaining a usable quota cache when an API poll returns
 * no windows (an unavailable response, not a zero-usage response).
 * Run: node --import=./packages/pi-usage-block/test/extensionless-loader.mjs --test packages/pi-usage-block/src/index.test.ts
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import usageBlock from "./index.ts";
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";

type Handler = (...args: any[]) => any;

const PROVIDER_ID = "usage-block-empty-cache-test";

function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("timed out waiting for usage refresh"));
      setTimeout(check, 5);
    };
    check();
  });
}

let shutdownActive: (() => void) | undefined;

afterEach(() => {
  shutdownActive?.();
  shutdownActive = undefined;
  usageRegistry.unregister(PROVIDER_ID);
});

test("an empty quota response preserves the previous status-bar cache", async () => {
  const handlers = new Map<string, Handler>();
  let usageCommand: { handler: Handler } | undefined;
  const statuses: Array<string | undefined> = [];
  let calls = 0;

  usageRegistry.register({
    id: PROVIDER_ID,
    name: "Test quota",
    kind: "quota",
    source: "api",
    async fetchUsage() {
      calls++;
      return calls === 1
        ? [{ period: "five-hour", used: 50, limit: 100, unit: "tokens" }]
        : [];
    },
  });

  usageBlock({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      if (name === "usage") usageCommand = command;
    },
  } as any);

  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  assert.ok(start);
  assert.ok(shutdown);
  shutdownActive = () => shutdown();
  await start({}, {
    hasUI: true,
    model: { provider: PROVIDER_ID },
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    settings: { usageBlock: { refreshIntervalMs: 60_000 } },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  });

  await waitFor(() => statuses.includes("Test quota 50%"));
  assert.ok(usageCommand);

  const notices: string[] = [];
  await usageCommand.handler([], {
    ui: { notify: (message: string) => notices.push(message) },
  });

  assert.equal(calls, 2);
  assert.match(notices[0]!, /Test quota \*\(active\)\*.*🟢 50%/);
});
