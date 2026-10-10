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
  thinkingLevelMap?: Record<string, string | null>;
  compat?: { supportsReasoningEffort?: boolean; thinkingFormat?: string };
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
  authHeader: boolean;
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

// Shape returned by GET /v1/models (verified live 2026-10-10): ids plus
// context_window/max_output; u2-med reports a null max_output.
const LIVE_CATALOG = {
  data: [
    { id: "glm-5.2", context_window: 1_048_576, max_output: 131_072 },
    { id: "u2-flash", context_window: 524_288, max_output: 131_072 },
    { id: "u2-med", context_window: 262_144, max_output: null },
    { id: "brand-new-model", context_window: 999_999, max_output: 88_888 },
  ],
};

/** A persisted chat entry as written by a previous successful refresh. */
const STORED_CHAT_MODEL = {
  id: "u2-flash",
  name: "U2 Flash",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0 },
  contextWindow: 524_288,
  maxTokens: 131_072,
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

test("registers both channels with the shared catalog and refresh hooks", () => {
  const providers = registeredConfig();
  const payg = providers["unisound"];
  const plan = providers["unisound-plan"];
  assert.ok(payg && plan);
  assert.equal(payg.baseUrl, "https://maas-api.unisound.com/v1");
  assert.equal(payg.apiKey, "$UNISOUND_API_KEY");
  assert.equal(plan.apiKey, "$UNISOUND_PLAN_API_KEY");
  assert.equal(typeof payg.refreshModels, "function");
  assert.equal(typeof plan.refreshModels, "function");
  assert.equal(payg.models.length, 22);
  assert.deepEqual(
    plan.models.map((m) => m.id),
    payg.models.map((m) => m.id),
  );
  // Channel costs differ: u2-flash is metered on payg, zero on plan.
  const flashPayg = payg.models.find((m) => m.id === "u2-flash");
  const flashPlan = plan.models.find((m) => m.id === "u2-flash");
  assert.equal(flashPayg?.cost.input, 0.14);
  assert.equal(flashPlan?.cost.input, 0);
  // u2-radimed is delisted (absent from the live catalog).
  assert.ok(!payg.models.some((m) => m.id === "u2-radimed"));
});

test("offline phase without a stored catalog keeps the channel fallback", async () => {
  const providers = registeredConfig();
  const payg = await providers["unisound"].refreshModels?.(makeContext({ allowNetwork: false }));
  const plan = await providers["unisound-plan"].refreshModels?.(makeContext({ allowNetwork: false }));
  assert.equal(payg?.length, 22);
  assert.equal(plan?.length, 22);
  assert.equal(plan?.[0].cost.input, 0);
});

test("offline phase restores a persisted catalog and skips non-chat entries", async () => {
  const providers = registeredConfig();
  const stored = [STORED_CHAT_MODEL, { id: "had-image-entry", type: "image", input: ["text"] }];
  const payg = await providers["unisound"].refreshModels?.(
    makeContext({ allowNetwork: false, stored: { models: stored } }),
  );
  assert.deepEqual(
    payg?.map((m) => m.id),
    ["u2-flash"],
  );
  assert.equal(payg?.[0].contextWindow, 524_288);
  assert.equal(payg?.[0].cost.input, 0.14);
  // Plan restore re-resolves subscription cost even if the snapshot was
  // written by the payg channel.
  const plan = await providers["unisound-plan"].refreshModels?.(
    makeContext({ allowNetwork: false, stored: { models: stored } }),
  );
  assert.equal(plan?.[0].cost.input, 0);
});

test("network phase maps catalog limits and fills gaps from shipped specs", async () => {
  const providers = registeredConfig();
  const publications: unknown[] = [];
  await withFetchStub(LIVE_CATALOG, async () => {
    const result = await providers["unisound"].refreshModels?.(
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
      ["glm-5.2", "u2-flash", "u2-med", "brand-new-model"],
    );
    // Catalog limits win.
    assert.equal(result?.[0].contextWindow, 1_048_576);
    assert.equal(result?.[0].maxTokens, 131_072);
    // Null max_output falls back to the shipped placeholder.
    const med = result?.find((m) => m.id === "u2-med");
    assert.equal(med?.maxTokens, 65_536);
    assert.equal(med?.compat?.supportsReasoningEffort, true);
    // Unknown ids get family defaults (toggle contract, no effort).
    const brand = result?.find((m) => m.id === "brand-new-model");
    assert.equal(brand?.contextWindow, 999_999); // catalog value still wins
    assert.equal(brand?.maxTokens, 88_888);
    assert.equal(brand?.compat?.supportsReasoningEffort, false);
    assert.equal(brand?.thinkingLevelMap?.high, "enabled");
  });
  assert.equal(publications.length, 1);
  const persist = (publications[0] as { persist?: { models?: unknown[]; checkedAt?: number } })
    .persist;
  assert.ok(persist);
  assert.equal(typeof persist.checkedAt, "number");
  assert.equal(persist.models?.length, 4);
});

test("network phase skips fetching while the persisted snapshot is fresh", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["unisound"].refreshModels;
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
      ["u2-flash"],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("forced refresh bypasses the freshness window", async () => {
  const providers = registeredConfig();
  await withFetchStub(LIVE_CATALOG, async () => {
    const result = await providers["unisound"].refreshModels?.(
      makeContext({
        allowNetwork: true,
        force: true,
        stored: { models: [STORED_CHAT_MODEL], checkedAt: Date.now() },
      }),
    );
    assert.deepEqual(
      result?.map((m) => m.id),
      ["glm-5.2", "u2-flash", "u2-med", "brand-new-model"],
    );
  });
});

test("network phase fails fast when no API key credential is available", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["unisound"].refreshModels;
  assert.ok(refreshModels);
  const original = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => LIVE_CATALOG } as unknown as Response;
  };
  try {
    await assert.rejects(
      refreshModels(makeContext({ allowNetwork: true, credential: undefined })),
      /UNISOUND_API_KEY is not configured/,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetchCalled, false);
});

test("network phase surfaces HTTP errors so pi keeps the previous list", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["unisound"].refreshModels;
  assert.ok(refreshModels);
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 }) as unknown as Response;
  try {
    await assert.rejects(refreshModels(makeContext({ allowNetwork: true })), /returned HTTP 503/);
  } finally {
    globalThis.fetch = original;
  }
});

test("network phase rejects unexpected response shapes and empty catalogs", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["unisound"].refreshModels;
  assert.ok(refreshModels);
  await withFetchStub({ foo: "bar" }, async () => {
    await assert.rejects(
      refreshModels(makeContext({ allowNetwork: true })),
      /unexpected response shape/,
    );
  });
  await withFetchStub({ data: [] }, async () => {
    await assert.rejects(refreshModels(makeContext({ allowNetwork: true })), /no models/);
  });
});
