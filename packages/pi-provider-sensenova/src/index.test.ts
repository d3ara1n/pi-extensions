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
  compat?: { supportsDeveloperRole: boolean; supportsReasoningEffort: boolean };
}

interface RefreshContextLike {
  allowNetwork: boolean;
  stored?: { models?: unknown[] };
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

function registeredConfig(): RegisteredProvider {
  const providers: Record<string, RegisteredProvider> = {};
  register({
    registerProvider(id: string, config: RegisteredProvider) {
      providers[id] = config;
    },
  } as unknown as ExtensionAPI);
  const config = providers["sensenova-plan"];
  assert.ok(config, "sensenova-plan provider is registered");
  return config;
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

const LIVE_CATALOG = {
  data: [
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      input_modalities: ["text"],
      output_modalities: ["text"],
      context_length: 1_048_576,
      max_output_length: 65_536,
      supported_features: ["tools", "json_mode", "reasoning"],
      pricing: { prompt: "0", completion: "0", input_cache_read: "0" },
    },
    {
      id: "sensenova-6.8-flash-lite",
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      context_length: 262_144,
      max_output_length: 65_536,
      supported_features: ["reasoning"],
      pricing: { prompt: "0", completion: "0" },
    },
    // Image-generation model: must be filtered out by output_modalities.
    {
      id: "sensenova-u1.5-lite",
      input_modalities: ["text"],
      output_modalities: ["image"],
      context_length: 262_144,
      max_output_length: 65_536,
      supported_features: ["reasoning"],
      pricing: { prompt: "0" },
    },
    // Older catalog shape without modalities: kept as chat (id does not match the image-gen heuristic).
    { id: "legacy-model", context_length: 262_144, max_output_length: 65_536 },
    // Older catalog shape without modalities: excluded by the image-gen id heuristic.
    { id: "sensenova-u1.5-legacy", context_length: 262_144, max_output_length: 65_536 },
  ],
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

test("registers the sensenova-plan provider with fallback models and a refresh hook", () => {
  const config = registeredConfig();
  assert.equal(config.name, "SenseNova (Token Plan)");
  assert.equal(config.baseUrl, "https://token.sensenova.cn/v1");
  assert.equal(config.apiKey, "$SENSENOVA_API_KEY");
  assert.equal(config.api, "openai-completions");
  assert.equal(config.authHeader, true);
  assert.equal(typeof config.refreshModels, "function");
  assert.ok(config.models.length > 0);
  assert.ok(config.models.some((model) => model.id === "kimi-k3"));
});

test("offline phase without a stored catalog keeps the fallback list", async () => {
  const result = await registeredConfig().refreshModels?.(makeContext({ allowNetwork: false }));
  assert.ok(result);
  assert.deepEqual(
    result.map((model) => model.id),
    [
      "sensenova-6.7-flash-lite",
      "sensenova-6.8-flash-lite",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "glm-5.2",
      "kimi-k3",
    ],
  );
});

test("offline phase restores a persisted catalog and skips non-chat entries", async () => {
  const storedModels = [
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 393_216,
    },
    { id: "had-image-entry", type: "image", input: ["text"] },
  ];
  const result = await registeredConfig().refreshModels?.(
    makeContext({ allowNetwork: false, stored: { models: storedModels } }),
  );
  assert.ok(result);
  assert.deepEqual(
    result.map((model) => model.id),
    ["deepseek-v4-pro"],
  );
  assert.equal(result[0].contextWindow, 1_048_576);
  assert.equal(result[0].maxTokens, 393_216);
  assert.equal(result[0].cost.cacheRead, 3);
});

test("network phase maps the live catalog, filters image models, and publishes a snapshot", async () => {
  const publications: unknown[] = [];
  const config = registeredConfig();
  await withFetchStub(LIVE_CATALOG, async () => {
    const result = await config.refreshModels?.(
      makeContext({
        allowNetwork: true,
        publish: async (publication) => {
          publications.push(publication);
          return true;
        },
      }),
    );
    assert.ok(result);
    assert.deepEqual(
      result.map((model) => model.id),
      ["deepseek-v4-flash", "sensenova-6.8-flash-lite", "legacy-model"],
    );
    const flash = result.find((model) => model.id === "deepseek-v4-flash");
    assert.ok(flash);
    assert.equal(flash.contextWindow, 1_048_576);
    assert.equal(flash.maxTokens, 65_536);
    assert.equal(flash.reasoning, true);
    assert.deepEqual(flash.input, ["text"]);
    assert.deepEqual(flash.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const lite = result.find((model) => model.id === "sensenova-6.8-flash-lite");
    assert.deepEqual(lite?.input, ["text", "image"]);
  });
  assert.equal(publications.length, 1);
  const persist = (publications[0] as { persist?: { models?: unknown[]; checkedAt?: number } })
    .persist;
  assert.ok(persist);
  assert.deepEqual(
    (persist.models ?? []).map((model) => (model as { id: string }).id),
    ["deepseek-v4-flash", "sensenova-6.8-flash-lite", "legacy-model"],
  );
  assert.equal(typeof persist.checkedAt, "number");
});

test("network phase fails fast when no API key credential is available", async () => {
  const config = registeredConfig();
  const refreshModels = config.refreshModels;
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
      /SENSENOVA_API_KEY is not configured/,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetchCalled, false);
});

test("network phase surfaces HTTP errors so pi keeps the previous list", async () => {
  const config = registeredConfig();
  const refreshModels = config.refreshModels;
  assert.ok(refreshModels);
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 }) as unknown as Response;
  try {
    await assert.rejects(refreshModels(makeContext({ allowNetwork: true })), /returned HTTP 503/);
  } finally {
    globalThis.fetch = original;
  }
});

test("network phase rejects unexpected response shapes", async () => {
  const config = registeredConfig();
  const refreshModels = config.refreshModels;
  assert.ok(refreshModels);
  await withFetchStub({ foo: "bar" }, async () => {
    await assert.rejects(
      refreshModels(makeContext({ allowNetwork: true })),
      /unexpected response shape/,
    );
  });
});
