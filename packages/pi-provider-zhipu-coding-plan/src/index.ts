/**
 * pi-provider-zhipu-coding-plan
 *
 * Registers "zhipu-coding" provider with static model list
 * and usage quota reporting via the shared UsageRegistry.
 *
 * Auth: API key resolved via modelRegistry.getApiKeyForProvider.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { usageRegistry } from "@d3ara1n/pi-usage-block-core";
import type { QuotaProvider, QuotaWindow } from "@d3ara1n/pi-usage-block-core";

// ── Config ────────────────────────────────────────────────────────────────

const PROVIDER_ID = "zhipu-coding";
const PROVIDER_NAME = "Zhipu AI (Coding Plan)";
const CODING_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const QUOTA_API_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit";
const API_KEY_ENV = "ZHIPUAI_API_KEY";

// ── Types ─────────────────────────────────────────────────────────────────

interface ModelMeta {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  compat: Record<string, unknown>;
}

interface QuotaLimitItem {
  type: "TOKENS_LIMIT" | "TIME_LIMIT";
  percentage?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  nextResetTime?: number;
  /** Window duration count (e.g. 5) paired with unit */
  number?: number;
  /** Window duration unit: 3 = hours */
  unit?: number;
}

interface QuotaResponse {
  code: number;
  success: boolean;
  data?: { limits?: QuotaLimitItem[]; level?: string };
}

// ── Known model metadata ─────────────────────────────────────────────────

const DEFAULT_META: ModelMeta = {
  contextWindow: 128_000,
  maxTokens: 16_384,
  reasoning: true,
  input: ["text"],
  compat: { supportsDeveloperRole: false, thinkingFormat: "zai" },
};

const ZAI_STREAM = {
  supportsDeveloperRole: false,
  thinkingFormat: "zai",
  zaiToolStream: true,
} as const;

const KNOWN_MODELS: Record<string, Partial<ModelMeta>> = {
  "glm-4.5": { contextWindow: 131_072, maxTokens: 98_304 },
  "glm-4.5-air": { contextWindow: 131_072, maxTokens: 98_304 },
  "glm-4.6": { contextWindow: 200_000, maxTokens: 131_072 },
  "glm-4.7": { contextWindow: 200_000, maxTokens: 131_072, compat: ZAI_STREAM },
  "glm-5": { contextWindow: 200_000, maxTokens: 131_072, compat: ZAI_STREAM },
  "glm-5-turbo": { contextWindow: 200_000, maxTokens: 131_072, compat: ZAI_STREAM },
  "glm-5.1": { contextWindow: 200_000, maxTokens: 131_072, compat: ZAI_STREAM },
  "glm-5.2": { contextWindow: 1_000_000, maxTokens: 131_072, compat: ZAI_STREAM },
};

// ── API helpers ───────────────────────────────────────────────────────────

async function fetchQuota(apiKey: string): Promise<QuotaResponse | null> {
  try {
    const res = await fetch(QUOTA_API_URL, {
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as QuotaResponse;
    return body.success ? body : null;
  } catch {
    return null;
  }
}

// ── Model config builder ──────────────────────────────────────────────────

function buildModelConfig(id: string) {
  const k = KNOWN_MODELS[id];
  return {
    id,
    name: id
      .replace(/^glm-/, "GLM-")
      .replace(/-/g, " ")
      .replace(/\b(\w)/g, (_, c: string) => c.toUpperCase()),
    api: "openai-completions" as const,
    reasoning: k?.reasoning ?? DEFAULT_META.reasoning,
    input: k?.input ?? DEFAULT_META.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // subscription plan
    contextWindow: k?.contextWindow ?? DEFAULT_META.contextWindow,
    maxTokens: k?.maxTokens ?? DEFAULT_META.maxTokens,
    compat: { ...DEFAULT_META.compat, ...(k?.compat ?? {}) },
  };
}

const MODELS = Object.keys(KNOWN_MODELS).map(buildModelConfig);

// ── Usage provider ────────────────────────────────────────────────────────

/** Resolved on session_start; getApiKeyForProvider reads auth.json/env/models.json. */
let modelRegistry: any;

function createUsageProvider(): QuotaProvider {
  return {
    kind: "quota",
    id: PROVIDER_ID,
    name: "Zhipu Coding",
    source: "api",
    async fetchUsage(): Promise<QuotaWindow[]> {
      if (!modelRegistry) return [];
      let apiKey: string | undefined;
      try { apiKey = await modelRegistry.getApiKeyForProvider(PROVIDER_ID); } catch { /* not configured */ }
      if (!apiKey) return [];

      const quota = await fetchQuota(apiKey);
      if (!quota?.data?.limits?.length) return [];

      const limits = quota.data.limits;

      // Each TOKENS_LIMIT is a quota window (5h, weekly, etc.)
      // It carries its own percentage and nextResetTime.
      // Lite plan has one; Pro plan may have two (5h + weekly).
      const windows = limits
        .filter((l) => l.type === "TOKENS_LIMIT" && typeof l.percentage === "number")
        .map((l) => {
          const period = l.number && l.unit ? `${l.number}${l.unit === 3 ? "h" : "w"}` : "";
          return {
            period,
            used: l.percentage!,
            limit: 100,
            unit: "tokens" as const,
            resetAt: l.nextResetTime ? new Date(l.nextResetTime) : undefined,
          };
        });

      return windows;
    },
  };
}

// ── Entry point ───────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: CODING_BASE_URL,
    apiKey: `$${API_KEY_ENV}`,
    api: "openai-completions",
    authHeader: true,
    models: MODELS,
  });

  usageRegistry.register(createUsageProvider());

  pi.on("session_start", (_e, c) => {
    modelRegistry = (c as any).modelRegistry;
  });
}
