import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

interface ChatModelLike {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: { thinkingFormat?: string };
}

interface RefreshContextLike {
  allowNetwork: boolean;
  force?: boolean;
  stored?: { models?: unknown[]; checkedAt?: number };
  credential?: { type: "api_key" | "oauth"; key?: string };
  signal: AbortSignal;
  publish: (publication: unknown) => Promise<boolean>;
}

interface RegisteredProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  models: ChatModelLike[];
  refreshModels?: (context: RefreshContextLike) => Promise<ChatModelLike[]>;
}

function registeredConfig(): Record<string, RegisteredProvider> {
  const providers: Record<string, RegisteredProvider> = {};
  register({
    registerProvider(id: string, config: RegisteredProvider) {
      providers[id] = config;
    },
  } as unknown as ExtensionAPI);
  return providers;
}

function makeContext(overrides: Partial<RefreshContextLike> = {}): RefreshContextLike {
  return {
    allowNetwork: false,
    credential: { type: "api_key", key: "sk-test" },
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  };
}

// Shape returned by GET /v1/models (verified live 2026-10-10): ids only.
const LIVE_CATALOG = {
  data: [
    { id: "agnes-2.5-flash" },
    { id: "agnes-3.0-flash" },
    { id: "agnes-2.5-pro" },
    { id: "agnes-image-2.5-flash" },
    { id: "agnes-video-2.5" },
  ],
};

/** A persisted chat entry as written by a previous successful refresh. */
const STORED_CHAT_MODEL = {
  id: "agnes-2.5-flash",
  name: "Agnes 2.5 Flash",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 512_000,
  maxTokens: 65_500,
};

async function withFetchStub(response: unknown, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    ({ ok: true, status: 200, json: async () => response }) as unknown as Response;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("registers both providers with the live chat catalog and refresh hooks", () => {
  const providers = registeredConfig();
  const agnes = providers["agnes"];
  const plan = providers["agnes-plan"];
  assert.ok(agnes && plan);
  assert.equal(agnes.baseUrl, "https://apihub.agnes-ai.com/v1");
  assert.equal(agnes.apiKey, "$AGNES_API_KEY");
  assert.equal(plan.apiKey, "$AGNES_PLAN_API_KEY");
  assert.equal(typeof agnes.refreshModels, "function");
  assert.equal(typeof plan.refreshModels, "function");
  assert.deepEqual(
    agnes.models.map((m) => m.id),
    [
      "agnes-2.5-flash",
      "agnes-2.0-flash",
      "agnes-2.5-pro",
      "agnes-2.5-pro-beta",
      "agnes-2.5-pro-alpha",
      "agnes-3.0-flash",
      "agnes-3.0-flash-max",
    ],
  );
  // agnes-1.5-flash is delisted (absent from the live catalog since
  // 2026-10-10).
  assert.ok(!agnes.models.some((m) => m.id === "agnes-1.5-flash"));
});

test("offline phase restores a persisted catalog, keeps fallback otherwise", async () => {
  const providers = registeredConfig();
  const fallback = await providers["agnes"].refreshModels?.(makeContext({ allowNetwork: false }));
  assert.equal(fallback?.length, 7);
  const restored = await providers["agnes"].refreshModels?.(
    makeContext({
      allowNetwork: false,
      stored: { models: [STORED_CHAT_MODEL, { id: "img", type: "image" }] },
    }),
  );
  assert.deepEqual(
    restored?.map((m) => m.id),
    ["agnes-2.5-flash"],
  );
  assert.equal(restored?.[0].contextWindow, 512_000);
});

test("network phase filters generation families and fills specs by id", async () => {
  const providers = registeredConfig();
  const publications: unknown[] = [];
  await withFetchStub(LIVE_CATALOG, async () => {
    const result = await providers["agnes"].refreshModels?.(
      makeContext({
        allowNetwork: true,
        publish: async (publication) => {
          publications.push(publication);
          return true;
        },
      }),
    );
    assert.deepEqual(
      result?.map((m) => m.id),
      ["agnes-2.5-flash", "agnes-3.0-flash", "agnes-2.5-pro"],
    );
    // Known id: shipped specs preserved.
    const flash = result?.find((m) => m.id === "agnes-2.5-flash");
    assert.equal(flash?.contextWindow, 512_000);
    assert.equal(flash?.maxTokens, 65_500);
    assert.equal(flash?.name, "Agnes 2.5 Flash");
    // New id: family defaults (text+image, qwen-chat-template thinking).
    const pro = result?.find((m) => m.id === "agnes-2.5-pro");
    assert.equal(pro?.contextWindow, 262_144);
    assert.deepEqual(pro?.input, ["text", "image"]);
    assert.equal(pro?.compat?.thinkingFormat, "qwen-chat-template");
  });
  assert.equal(publications.length, 1);
});

test("network phase skips fetching while the persisted snapshot is fresh", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["agnes-plan"].refreshModels;
  assert.ok(refreshModels);
  const original = globalThis.fetch;
  let fetchCalled = false;
  let published = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => LIVE_CATALOG } as unknown as Response;
  };
  try {
    const result = await refreshModels(
      makeContext({
        allowNetwork: true,
        stored: { models: [STORED_CHAT_MODEL], checkedAt: Date.now() },
        publish: async () => {
          published = true;
          return true;
        },
      }),
    );
    assert.equal(fetchCalled, false);
    assert.equal(published, false);
    assert.deepEqual(
      result.map((m) => m.id),
      ["agnes-2.5-flash"],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("forced refresh bypasses the freshness window", async () => {
  const providers = registeredConfig();
  await withFetchStub(LIVE_CATALOG, async () => {
    const result = await providers["agnes"].refreshModels?.(
      makeContext({
        allowNetwork: true,
        force: true,
        stored: { models: [STORED_CHAT_MODEL], checkedAt: Date.now() },
      }),
    );
    assert.equal(result?.length, 3);
  });
});

test("network phase fails fast without a credential and surfaces HTTP errors", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["agnes"].refreshModels;
  assert.ok(refreshModels);
  const original = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: false, status: 401 } as unknown as Response;
  };
  try {
    await assert.rejects(
      refreshModels(makeContext({ allowNetwork: true, credential: undefined })),
      /AGNES_API_KEY is not configured/,
    );
    assert.equal(fetchCalled, false);
    await assert.rejects(refreshModels(makeContext({ allowNetwork: true })), /returned HTTP 401/);
  } finally {
    globalThis.fetch = original;
  }
});

test("chat-empty catalogs are rejected so the previous list is kept", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["agnes"].refreshModels;
  assert.ok(refreshModels);
  await withFetchStub({ data: [{ id: "agnes-image-2.5-flash" }] }, async () => {
    await assert.rejects(refreshModels(makeContext({ allowNetwork: true })), /no chat models/);
  });
  await withFetchStub({ foo: "bar" }, async () => {
    await assert.rejects(
      refreshModels(makeContext({ allowNetwork: true })),
      /unexpected response shape/,
    );
  });
});
