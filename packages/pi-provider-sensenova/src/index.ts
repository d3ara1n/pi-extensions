/**
 * pi-provider-sensenova
 *
 * Registers "sensenova-plan" provider for SenseNova (商汤日日新) Token Plan.
 *
 * The model catalog is refreshed from the live API (`GET /v1/models`) when
 * the persisted snapshot is stale (4-hour window, matching pi's built-in
 * remote catalog) and restored from the snapshot on offline startups, so
 * newly published models appear without a plugin update. `pi update
 * --models` forces an immediate refresh. The static `FALLBACK_MODELS` list
 * below is only used until the first successful network refresh (or when
 * refresh keeps failing).
 *
 * Chat-completions models are registered; image-generation-only models are
 * filtered out via `output_modalities`.
 *
 * Usage quota/balance reporting is not yet implemented — SenseNova does not
 * currently expose a public quota or balance API. Free during public beta.
 */
import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

/** Chat-model branch of the `ProviderModelConfig` union. */
type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

// ── Constants ─────────────────────────────────────────────────────────────

const PROVIDER_ID = "sensenova-plan";
const PROVIDER_NAME = "SenseNova (Token Plan)";
const BASE_URL = "https://token.sensenova.cn/v1";
const MODELS_PATH = `${BASE_URL}/models`;
const API_KEY_ENV = "SENSENOVA_API_KEY";
const REFRESH_TIMEOUT_MS = 10_000;
/** Freshness window matching pi's built-in remote catalog (4 hours). */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const REASONING = {
  // SenseNova rejects pi's `minimal` level. The API accepts low/medium/high/none.
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
} as const;

const CHAT_COMPAT = {
  supportsDeveloperRole: false, // uses `system` role, not `developer`
  supportsReasoningEffort: true, // required for thinkingLevelMap to emit reasoning_effort
} as const;

// Fallback catalog: used before the first network refresh succeeds and kept
// whenever the live catalog cannot be fetched (offline, HTTP errors, aborts).
const FALLBACK_MODELS: ChatModelConfig[] = [
  {
    // Listed by the live catalog (re-checked 2026-10-10).
    // re-registers automatically if it returns.
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash Lite",
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 262_144,
    maxTokens: 65_536,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  },
  {
    // New in the live catalog (first seen 2026-10).
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  },
  {
    // New in the live catalog (first seen 2026-10).
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  },
  {
    // Catalog (2026-10) now reports text-only input and 64K max output;
    // earlier specs advertised text+image / 1M output — catalog wins.
    id: "kimi-k3",
    name: "Kimi K3",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  },
  // sensenova-6.7-flash-lite and deepseek-v4-pro are delisted (absent from
  // the live catalog since 2026-10) — removed; they re-register
  // automatically if they return.
];

/** Shipped specs by model id, used to fill gaps in live catalog entries. */
const KNOWN_MODELS = new Map(FALLBACK_MODELS.map((model) => [model.id, model]));

// ── Types ─────────────────────────────────────────────────────────────────

type RefreshModelsContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];
type ModelsStoreEntry = NonNullable<Parameters<RefreshModelsContext["publish"]>[0]["persist"]>;

/** OpenAI-compatible `GET /v1/models` catalog entry. */
interface RemoteModel {
  id: string;
  name?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  context_length?: number;
  max_output_length?: number;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    image?: string | number;
    request?: string | number;
    input_cache_read?: string | number;
  };
  supported_features?: string[];
  businesses?: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function toNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Chat models output text. Image-generation models (e.g. `sensenova-u1.5-lite`) output `image` and are excluded. */
function isChatModel(model: RemoteModel): boolean {
  const output = model.output_modalities;
  if (Array.isArray(output)) return output.includes("text");
  // Older catalogs may omit modalities; exclude the known image-gen families.
  return !/^sensenova-u1(\.|$|-)/.test(model.id);
}

function remoteToChatConfig(model: RemoteModel): ChatModelConfig {
  // Prefer shipped specs for known ids when the live entry omits fields.
  const known = KNOWN_MODELS.get(model.id);
  const knownCost = known?.cost ?? ZERO_COST;
  return {
    id: model.id,
    name: model.name || known?.name || model.id,
    reasoning: model.supported_features?.includes("reasoning") ?? known?.reasoning ?? true,
    input: (model.input_modalities ?? known?.input ?? ["text"]).filter((m) => m === "text" || m === "image") as (
      | "text"
      | "image"
    )[],
    cost: {
      input: model.pricing?.prompt !== undefined ? toNumber(model.pricing.prompt) : knownCost.input,
      output: model.pricing?.completion !== undefined ? toNumber(model.pricing.completion) : knownCost.output,
      cacheRead:
        model.pricing?.input_cache_read !== undefined
          ? toNumber(model.pricing.input_cache_read)
          : knownCost.cacheRead,
      cacheWrite: knownCost.cacheWrite, // SenseNova reports no cache-write pricing
    },
    contextWindow: model.context_length ?? known?.contextWindow ?? 262_144,
    maxTokens: model.max_output_length ?? known?.maxTokens ?? 65_536,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  };
}

/** Convert a persisted catalog entry (pi model objects) back to chat configs. */
function storedToChatConfigs(models: readonly unknown[]): ChatModelConfig[] {
  const configs: ChatModelConfig[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (m.type !== undefined && m.type !== "chat") continue; // image/classifier entries
    const id = typeof m.id === "string" ? m.id : "";
    if (!id) continue;
    const cost = (m.cost ?? ZERO_COST) as {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
    };
    configs.push({
      id,
      name: typeof m.name === "string" ? m.name : id,
      reasoning: typeof m.reasoning === "boolean" ? m.reasoning : true,
      input: (Array.isArray(m.input) ? m.input : ["text"]) as ("text" | "image")[],
      cost: {
        input: toNumber(cost?.input as string | number | undefined),
        output: toNumber(cost?.output as string | number | undefined),
        cacheRead: toNumber(cost?.cacheRead as string | number | undefined),
        cacheWrite: toNumber(cost?.cacheWrite as string | number | undefined),
      },
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : 262_144,
      maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : 65_536,
      thinkingLevelMap: (m.thinkingLevelMap ?? REASONING) as ChatModelConfig["thinkingLevelMap"],
      compat: (m.compat ?? CHAT_COMPAT) as ChatModelConfig["compat"],
    });
  }
  return configs;
}

async function fetchRemoteCatalog(
  signal: AbortSignal,
  apiKey: string | undefined,
): Promise<RemoteModel[]> {
  if (!apiKey) throw new Error(`${API_KEY_ENV} is not configured for ${PROVIDER_ID}`);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(MODELS_PATH, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`SenseNova ${MODELS_PATH} returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: RemoteModel[] };
    if (!Array.isArray(body?.data)) {
      throw new Error(`SenseNova ${MODELS_PATH} returned an unexpected response shape`);
    }
    return body.data;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** Restore the persisted catalog when present; otherwise the static fallback. */
function restoreStored(context: RefreshModelsContext): ChatModelConfig[] {
  const stored = context.stored?.models;
  return stored?.length ? storedToChatConfigs(stored as readonly unknown[]) : FALLBACK_MODELS;
}

/**
 * Two-phase refresh driven by pi on startup:
 *
 * - Offline phase (`allowNetwork: false`): restore the persisted catalog when
 *   present, otherwise leave the fallback list in place.
 * - Network phase (`allowNetwork: true`): skip the fetch while the persisted
 *   snapshot is younger than `REFRESH_INTERVAL_MS` (parity with pi's built-in
 *   remote catalog); `force` (e.g. `pi update --models`) bypasses the window.
 *   Otherwise fetch `GET /v1/models` with the configured credential, persist a
 *   snapshot for offline startups, and replace the live model list. On failure
 *   pi keeps the previous list.
 */
async function refreshModels(context: RefreshModelsContext): Promise<ChatModelConfig[]> {
  if (!context.allowNetwork) {
    // Cache-only phase: restore the persisted catalog when present; otherwise
    // keep the static fallback (re-applying it is a no-op).
    return restoreStored(context);
  }

  const checkedAt = context.stored?.checkedAt;
  if (
    !context.force &&
    typeof checkedAt === "number" &&
    Date.now() - checkedAt < REFRESH_INTERVAL_MS
  ) {
    // Fresh snapshot: skip the network round-trip and keep the restored list.
    return restoreStored(context);
  }

  const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
  const remote = await fetchRemoteCatalog(context.signal, apiKey);
  // pi discards the returned list once the signal is aborted, but the type
  // requires an array; returning the fallback is harmless.
  if (context.signal.aborted) return FALLBACK_MODELS;

  const models = remote.filter(isChatModel).map(remoteToChatConfig);
  if (models.length === 0) {
    // A chat-empty catalog is almost certainly an API anomaly; rejecting it
    // lets pi keep the previous list instead of registering nothing.
    throw new Error(`SenseNova ${MODELS_PATH} returned no chat models`);
  }

  await context.publish({
    persist: {
      models: models as unknown as ModelsStoreEntry["models"],
      checkedAt: Date.now(),
    },
  });

  return models;
}

// ── Entry point ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    apiKey: `$${API_KEY_ENV}`,
    api: "openai-completions",
    authHeader: true,
    models: FALLBACK_MODELS,
    refreshModels,
  });
}
