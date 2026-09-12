import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { BUILTIN_PROVIDERS } from "./builtin.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function tokenFor(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.signature`;
}

test("OpenAI Codex polls the ChatGPT usage endpoint and maps both quota windows", async () => {
  const token = tokenFor("account-123");
  let requestUrl = "";
  let requestHeaders: HeadersInit | undefined;

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestHeaders = init?.headers;
    return new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 42, reset_at: 1_900_000_000 },
        secondary_window: { used_percent: 7.5, reset_at: 1_900_100_000 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai-codex");
  assert.ok(definition);
  const provider = definition.build({
    apiKey: token,
    resolveApiKey: async () => token,
  });

  assert.equal(provider.id, "openai-codex");
  assert.equal(provider.source, "api");
  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);

  const windows = await provider.fetchUsage();
  assert.deepEqual(windows, [
    { period: "primary", used: 42, limit: 100, unit: "tokens", resetAt: new Date(1_900_000_000 * 1000) },
    { period: "secondary", used: 7.5, limit: 100, unit: "tokens", resetAt: new Date(1_900_100_000 * 1000) },
  ]);
  assert.equal(requestUrl, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(new Headers(requestHeaders).get("authorization"), `Bearer ${token}`);
  assert.equal(new Headers(requestHeaders).get("chatgpt-account-id"), "account-123");
});

test("OpenAI Codex refreshes its OAuth token before each usage poll", async () => {
  const initialToken = tokenFor("initial-account");
  const refreshedToken = tokenFor("refreshed-account");
  let resolved = 0;
  let accountHeader = "";

  globalThis.fetch = (async (_input, init) => {
    accountHeader = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
    return new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 1 } },
    }), { status: 200 });
  }) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai-codex");
  assert.ok(definition);
  const provider = definition.build({
    apiKey: initialToken,
    resolveApiKey: async () => {
      resolved++;
      return refreshedToken;
    },
  });

  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);
  await provider.fetchUsage();
  assert.equal(resolved, 1);
  assert.equal(accountHeader, "refreshed-account");
});

test("Kimi For Coding polls the usage endpoint and maps weekly + five-hour windows", async () => {
  let requestUrl = "";
  let authHeader = "";

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    authHeader = new Headers(init?.headers).get("authorization") ?? "";
    // Combined shape: weekly summary + a 5h row (numeric-string counts,
    // string duration) — the payload the coding plan normally returns.
    return new Response(JSON.stringify({
      usage: { name: "Weekly limit", used: "40", limit: "1000", resetTime: "2030-01-07T00:00:00.000Z" },
      limits: [{
        name: "Five-hour limit",
        window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
        detail: { used: "1", limit: "100", resetTime: "2030-01-01T05:00:00.000Z" },
      }],
    }), { status: 200 });
  }) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "kimi-coding");
  assert.ok(definition);
  const provider = definition.build({ apiKey: "kimi-key", resolveApiKey: async () => "kimi-key" });

  assert.equal(provider.kind, "quota");
  assert.equal(provider.source, "api");
  assert.ok(provider.fetchUsage);

  const windows = await provider.fetchUsage();
  // Shortest window first: 5h (300 min) before weekly (10080 min).
  assert.deepEqual(windows, [
    { period: "5h", used: 1, limit: 100, unit: "requests", resetAt: new Date("2030-01-01T05:00:00.000Z") },
    { period: "weekly", used: 40, limit: 1000, unit: "requests", resetAt: new Date("2030-01-07T00:00:00.000Z") },
  ]);
  assert.equal(requestUrl, "https://api.kimi.com/coding/v1/usages");
  assert.equal(authHeader, "Bearer kimi-key");
});

test("Kimi For Coding maps numeric windows and collapses duplicate weekly rows", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    usage: { used: "40", limit: "1000" },
    limits: [
      // Same weekly window as the summary via numeric fields → collapses to one.
      { name: "Weekly cap", window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" }, detail: { used: 99, limit: 999 } },
      // Numeric duration + DAY unit → "daily".
      { name: "Daily cap", window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { used: 5, limit: 100, resetTime: "2030-01-02T00:00:00Z" } },
    ],
  }), { status: 200 })) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "kimi-coding");
  assert.ok(definition);
  const provider = definition.build({ apiKey: "kimi-key", resolveApiKey: async () => "kimi-key" });

  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);

  const windows = await provider.fetchUsage();
  assert.deepEqual(windows, [
    { period: "daily", used: 5, limit: 100, unit: "requests", resetAt: new Date("2030-01-02T00:00:00Z") },
    // Summary row wins over the duplicate weekly limits row.
    { period: "weekly", used: 40, limit: 1000, unit: "requests", resetAt: undefined },
  ]);
});

test("Kimi For Coding drops malformed rows and unknown windows", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    usage: { used: "-1", limit: "10.5", resetTime: "not-a-timestamp" }, // negative + fractional → dropped
    limits: [
      { name: "dup-a", window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { used: "1", limit: "100" } },
      { name: "dup-b", window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { used: "2", limit: "100" } }, // 5h == 300min → duplicate
      { name: "unknown", window: { duration: 1, timeUnit: "TIME_UNIT_FORTNIGHT" }, detail: { used: "3", limit: "100" } },
      { name: "bad-reset", window: { duration: 24, timeUnit: "TIME_UNIT_HOUR" }, detail: { used: "5", limit: "100", resetTime: "invalid" } },
      { name: "missing-used", window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "100" } },
    ],
  }), { status: 200 })) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "kimi-coding");
  assert.ok(definition);
  const provider = definition.build({ apiKey: "kimi-key", resolveApiKey: async () => "kimi-key" });
  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);

  const windows = await provider.fetchUsage();
  assert.deepEqual(windows, [
    { period: "5h", used: 1, limit: 100, unit: "requests", resetAt: undefined },
    { period: "daily", used: 5, limit: 100, unit: "requests", resetAt: undefined }, // kept, invalid reset dropped
  ]);
});

test("Kimi For Coding derives used from remaining and tolerates alternate field spellings", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    // `remaining` instead of `used`, plus the `resetAt` spelling.
    usage: { limit: "100", remaining: "74", resetAt: "2030-01-07T00:00:00.000Z" },
    limits: [
      // Bare timeUnit (as the official CLI's fixtures spell it) + snake_case reset.
      { window: { duration: 300, timeUnit: "minute" }, detail: { limit: "100", remaining: "85", reset_time: "2030-01-01T05:00:00.000Z" } },
      // `used` wins when both counts are present; an unparsable resetTime falls through to resetAt.
      { window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { used: "5", remaining: "99", limit: "100", resetTime: "not-a-date", resetAt: "2030-01-02T00:00:00.000Z" } },
    ],
  }), { status: 200 })) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "kimi-coding");
  assert.ok(definition);
  const provider = definition.build({ apiKey: "kimi-key", resolveApiKey: async () => "kimi-key" });
  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);

  assert.deepEqual(await provider.fetchUsage(), [
    { period: "5h", used: 15, limit: 100, unit: "requests", resetAt: new Date("2030-01-01T05:00:00.000Z") },
    { period: "daily", used: 5, limit: 100, unit: "requests", resetAt: new Date("2030-01-02T00:00:00.000Z") },
    { period: "weekly", used: 26, limit: 100, unit: "requests", resetAt: new Date("2030-01-07T00:00:00.000Z") },
  ]);
});

test("Kimi For Coding maps a monthly window", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    limits: [{
      window: { duration: 1, timeUnit: "TIME_UNIT_MONTH" },
      detail: { used: "26", limit: "100", resetTime: "2030-02-01T00:00:00.000Z" },
    }],
  }), { status: 200 })) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "kimi-coding");
  assert.ok(definition);
  const provider = definition.build({ apiKey: "kimi-key", resolveApiKey: async () => "kimi-key" });
  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);

  assert.deepEqual(await provider.fetchUsage(), [
    { period: "monthly", used: 26, limit: 100, unit: "requests", resetAt: new Date("2030-02-01T00:00:00.000Z") },
  ]);
});

test("Kimi For Coding returns empty for an empty payload", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "kimi-coding");
  assert.ok(definition);
  const provider = definition.build({ apiKey: "kimi-key", resolveApiKey: async () => "kimi-key" });
  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);
  assert.deepEqual(await provider.fetchUsage(), []);
});

test("Kimi For Coding re-resolves its credential before each usage poll", async () => {
  let authHeader = "";
  let resolved = 0;
  globalThis.fetch = (async (_input, init) => {
    authHeader = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "kimi-coding");
  assert.ok(definition);
  const provider = definition.build({
    apiKey: "initial-key",
    resolveApiKey: async () => {
      resolved++;
      return `refreshed-key-${resolved}`;
    },
  });
  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);
  await provider.fetchUsage();
  assert.equal(resolved, 1);
  assert.equal(authHeader, "Bearer refreshed-key-1");
});

test("Kimi For Coding throws when no credential is available", async () => {
  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "kimi-coding");
  assert.ok(definition);
  const provider = definition.build({ apiKey: "unused", resolveApiKey: async () => undefined });
  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);
  await assert.rejects(provider.fetchUsage(), /credential unavailable/);
});
