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
  compat?: Record<string, unknown>;
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

async function withFetchUrlCapture(
  response: unknown,
  run: (urls: string[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input: unknown) => {
    urls.push(String((input as Request).url ?? input));
    return { ok: true, status: 200, json: async () => response } as unknown as Response;
  };
  try {
    await run(urls);
  } finally {
    globalThis.fetch = original;
  }
}

const LIVE_CATALOG = {
  data: [
    // Known shared model without metadata: shipped specs must win.
    { id: "step-5-preview" },
    // Known non-reasoning model: must NOT get a thinkingLevelMap.
    { id: "step-1o-turbo-vision", context_length: 32_768, max_output_length: 8_192 },
    // Unknown new model with metadata in the OpenAI dialect.
    {
      id: "step-6-epsilon",
      name: "Step 6 Epsilon",
      context_window: 2_000_000,
      max_output: 100_000,
      input_modalities: ["text", "image"],
    },
    // Image-only output modality: excluded.
    { id: "step-image-x", output_modalities: ["image"] },
  ],
};

/** A persisted chat entry as written by a previous successful refresh. */
const STORED_CHAT_MODEL = {
  id: "step-5-preview",
  name: "Step 5 Preview",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
};

test("registers both channels with static lists and per-channel refresh hooks", () => {
  const providers = registeredConfig();
  const std = providers["stepfun"];
  const plan = providers["stepfun-plan"];
  assert.ok(std && plan);
  assert.equal(std.baseUrl, "https://api.stepfun.com/v1");
  assert.equal(plan.baseUrl, "https://api.stepfun.com/step_plan/v1");
  assert.equal(std.apiKey, "$STEP_API_KEY");
  assert.equal(plan.apiKey, "$STEP_PLAN_API_KEY");
  assert.equal(typeof std.refreshModels, "function");
  assert.equal(typeof plan.refreshModels, "function");
  // Static lists stay intact until a live refresh lands.
  assert.ok(std.models.some((m) => m.id === "step-1o-turbo-vision"));
  assert.ok(!std.models.some((m) => m.id === "step-router-v1"));
  assert.ok(plan.models.some((m) => m.id === "step-router-v1"));
  for (const provider of [std, plan]) {
    const preview = provider.models.find((m) => m.id === "step-5-preview");
    assert.ok(preview);
    assert.equal(preview.contextWindow, 1_000_000);
    assert.equal(preview.maxTokens, 65_536);
    assert.deepEqual(preview.input, ["text", "image"]);
    assert.equal(preview.compat?.supportsDeveloperRole, false);
    assert.equal((preview.compat as { maxTokensField?: string }).maxTokensField, "max_tokens");
    const snapshot = provider.models.find((m) => m.id === "step-3.5-flash-2603");
    assert.equal(snapshot?.thinkingLevelMap?.medium, "low");
  }
});

test("each channel fetches its own base URL", async () => {
  const providers = registeredConfig();
  await withFetchUrlCapture({ data: [{ id: "step-5-preview" }] }, async (urls) => {
    await providers["stepfun"].refreshModels?.(makeContext({ allowNetwork: true }));
    await providers["stepfun-plan"].refreshModels?.(makeContext({ allowNetwork: true }));
    assert.deepEqual(urls, [
      "https://api.stepfun.com/v1/models",
      "https://api.stepfun.com/step_plan/v1/models",
    ]);
  });
});

test("network phase prefers shipped specs and gates thinking maps on reasoning", async () => {
  const providers = registeredConfig();
  const publications: unknown[] = [];
  await withFetchUrlCapture(LIVE_CATALOG, async () => {
    const result = await providers["stepfun"].refreshModels?.(
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
      ["step-5-preview", "step-1o-turbo-vision", "step-6-epsilon"],
    );
    // Known id without metadata: shipped specs preserved.
    const step5 = result?.find((m) => m.id === "step-5-preview");
    assert.equal(step5?.contextWindow, 1_000_000);
    assert.equal(step5?.maxTokens, 65_536);
    // Non-reasoning model: no thinkingLevelMap even though it is unknown
    // territory for the catalog dialect.
    const vision = result?.find((m) => m.id === "step-1o-turbo-vision");
    assert.equal(vision?.reasoning, false);
    assert.equal(vision?.thinkingLevelMap, undefined);
    assert.equal(vision?.contextWindow, 32_768); // catalog metadata wins
    // Unknown id: defaults incl. the shared thinking-level map.
    const epsilon = result?.find((m) => m.id === "step-6-epsilon");
    assert.equal(epsilon?.name, "Step 6 Epsilon");
    assert.equal(epsilon?.contextWindow, 2_000_000);
    assert.deepEqual(epsilon?.input, ["text", "image"]);
    assert.equal(epsilon?.thinkingLevelMap?.max, "high");
  });
  assert.equal(publications.length, 1);
  const persist = (publications[0] as { persist?: { models?: unknown[] } }).persist;
  assert.equal(persist?.models?.length, 3);
});

test("network phase skips fetching while the persisted snapshot is fresh", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["stepfun"].refreshModels;
  assert.ok(refreshModels);
  await withFetchUrlCapture(LIVE_CATALOG, async (urls) => {
    let published = false;
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
    assert.equal(urls.length, 0);
    assert.equal(published, false);
    assert.deepEqual(
      result.map((m) => m.id),
      ["step-5-preview"],
    );
  });
});

test("forced refresh bypasses the freshness window", async () => {
  const providers = registeredConfig();
  await withFetchUrlCapture(LIVE_CATALOG, async (urls) => {
    const result = await providers["stepfun-plan"].refreshModels?.(
      makeContext({
        allowNetwork: true,
        force: true,
        stored: { models: [STORED_CHAT_MODEL], checkedAt: Date.now() },
      }),
    );
    assert.equal(urls.length, 1);
    assert.equal(result?.length, 3);
  });
});

test("network phase fails fast without a credential and surfaces HTTP errors", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["stepfun"].refreshModels;
  assert.ok(refreshModels);
  const original = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: false, status: 429 } as unknown as Response;
  };
  try {
    await assert.rejects(
      refreshModels(makeContext({ allowNetwork: true, credential: undefined })),
      /STEP_API_KEY is not configured/,
    );
    assert.equal(fetchCalled, false);
    await assert.rejects(refreshModels(makeContext({ allowNetwork: true })), /returned HTTP 429/);
  } finally {
    globalThis.fetch = original;
  }
});

test("network phase rejects unexpected shapes and empty catalogs", async () => {
  const providers = registeredConfig();
  const refreshModels = providers["stepfun"].refreshModels;
  assert.ok(refreshModels);
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    ({ ok: true, json: async () => ({ models: [] }) }) as unknown as Response;
  try {
    await assert.rejects(
      refreshModels(makeContext({ allowNetwork: true })),
      /unexpected response shape/,
    );
  } finally {
    globalThis.fetch = original;
  }
  await withFetchUrlCapture({ data: [] }, async () => {
    await assert.rejects(refreshModels(makeContext({ allowNetwork: true })), /no chat models/);
  });
});
