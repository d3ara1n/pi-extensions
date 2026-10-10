/**
 * pi-provider-agnes
 *
 * Registers two Agnes AI providers:
 * - `agnes`      — token billing (pricing unpublished → cost 0)
 * - `agnes-plan` — subscription plan; cost = 0
 *
 * Both share the same base URL and model list (text + image input).
 *
 * The model catalog is refreshed from the live API (`GET /v1/models`) when
 * the persisted snapshot is stale (4-hour window, matching pi's built-in
 * remote catalog) and restored from the snapshot on offline startups; `pi
 * update --models` forces an immediate refresh. The endpoint returns only
 * ids (no context/pricing/modality metadata — verified live 2026-10-10),
 * so every field except id falls back to the shipped specs below; models
 * new to the catalog get the family defaults. Image-generation
 * (`agnes-image-*`) and video-generation (`agnes-video-*`) models are
 * excluded by id prefix — the catalog carries no modality field.
 *
 * Usage quota/balance reporting is not yet implemented — Agnes AI does not
 * currently expose a public quota or balance API. When one becomes
 * available, integrate via pi-usage-block-core (see plans/pi-provider-agnes.md).
 */
import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

/** Chat-model branch of the `ProviderModelConfig` union. */
type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

// ── Constants ─────────────────────────────────────────────────────────────

const BASE_URL = "https://apihub.agnes-ai.com/v1";
const MODELS_PATH = `${BASE_URL}/models`;
const REFRESH_TIMEOUT_MS = 10_000;
/** Freshness window matching pi's built-in remote catalog (4 hours). */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

// ── Models ────────────────────────────────────────────────────────────────

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// Agnes enables thinking via chat_template_kwargs.enable_thinking
// (Qwen-style), so reasoning models use the qwen-chat-template format.
const REASONING_COMPAT = { thinkingFormat: "qwen-chat-template" as const };

// Family defaults for models new to the catalog (specs beyond the id are
// not exposed by the endpoint): text+image input matches every verified
// Agnes chat model.
const DEFAULT_INPUT: ("text" | "image")[] = ["text", "image"];
const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 65_536;

interface ModelSpec {
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

// Verified against `GET /v1/models` 2026-10-10 (agnes-1.5-flash is no
// longer listed — removed). Specs for the 2.x models are live-verified;
// the 2.5-pro / 3.0 entries carry no endpoint metadata and await a
// real-link check.
const MODEL_SPECS: Record<string, ModelSpec> = {
  "agnes-2.5-flash": {
    name: "Agnes 2.5 Flash",
    reasoning: true,
    contextWindow: 512_000,
    maxTokens: 65_500,
  },
  "agnes-2.0-flash": {
    name: "Agnes 2.0 Flash",
    reasoning: true,
    contextWindow: 256_000,
    maxTokens: 64_000,
  },
  "agnes-2.5-pro": {
    name: "Agnes 2.5 Pro",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  "agnes-2.5-pro-beta": {
    name: "Agnes 2.5 Pro (Beta)",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  "agnes-2.5-pro-alpha": {
    name: "Agnes 2.5 Pro (Alpha)",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  "agnes-3.0-flash": {
    name: "Agnes 3.0 Flash",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  "agnes-3.0-flash-max": {
    name: "Agnes 3.0 Flash Max",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
};

const TEXT_MODELS: ChatModelConfig[] = Object.entries(MODEL_SPECS).map(([id, spec]) => ({
  id,
  name: spec.name,
  reasoning: spec.reasoning,
  input: [...DEFAULT_INPUT],
  cost: { ...ZERO_COST },
  contextWindow: spec.contextWindow,
  maxTokens: spec.maxTokens,
  ...(spec.reasoning ? { compat: REASONING_COMPAT } : {}),
}));

/** Shipped specs by model id, used to fill gaps in live catalog entries. */
const KNOWN_SPECS = new Map(Object.entries(MODEL_SPECS));

// ── Dynamic catalog refresh ───────────────────────────────────────────────

type RefreshModelsContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];
type ModelsStoreEntry = NonNullable<Parameters<RefreshModelsContext["publish"]>[0]["persist"]>;

/** `GET /v1/models` catalog entry — ids only, no metadata fields. */
interface RemoteModel {
  id: string;
}

/** Chat models only: the catalog mixes in image/video generation models. */
function isChatModel(model: RemoteModel): boolean {
  // The endpoint carries no modality field (verified live); the generation
  // families are cleanly prefixed.
  return !/^agnes-(image|video)-/.test(model.id);
}

function remoteToChatConfig(model: RemoteModel): ChatModelConfig {
  const known = KNOWN_SPECS.get(model.id);
  return {
    id: model.id,
    name: known?.name ?? model.id,
    reasoning: known?.reasoning ?? true,
    input: [...DEFAULT_INPUT],
    cost: { ...ZERO_COST },
    contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: known?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(known?.reasoning ?? true ? { compat: REASONING_COMPAT } : {}),
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
    const known = KNOWN_SPECS.get(id);
    configs.push({
      id,
      name: typeof m.name === "string" ? m.name : (known?.name ?? id),
      reasoning: typeof m.reasoning === "boolean" ? m.reasoning : (known?.reasoning ?? true),
      input: DEFAULT_INPUT,
      cost: { ...ZERO_COST },
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : (known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
      maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : (known?.maxTokens ?? DEFAULT_MAX_TOKENS),
      compat: REASONING_COMPAT,
    });
  }
  return configs;
}

async function fetchRemoteCatalog(signal: AbortSignal, apiKey: string | undefined): Promise<RemoteModel[]> {
  if (!apiKey) throw new Error(`AGNES_API_KEY is not configured for agnes`);
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
      throw new Error(`Agnes ${MODELS_PATH} returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: RemoteModel[] };
    if (!Array.isArray(body?.data)) {
      throw new Error(`Agnes ${MODELS_PATH} returned an unexpected response shape`);
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
  return stored?.length ? storedToChatConfigs(stored) : TEXT_MODELS;
}

/**
 * Two-phase refresh driven by pi on startup, per registration:
 *
 * - Offline phase (`allowNetwork: false`): restore the persisted catalog
 *   when present, otherwise leave the static list in place.
 * - Network phase (`allowNetwork: true`): skip the fetch while the
 *   persisted snapshot is younger than `REFRESH_INTERVAL_MS` (parity with
 *   pi's built-in remote catalog); `force` (e.g. `pi update --models`)
 *   bypasses the window. Otherwise fetch `GET /v1/models` with the
 *   registration's credential, persist a snapshot for offline startups,
 *   and replace the live model list. On failure pi keeps the previous
 *   list.
 */
async function refreshModels(context: RefreshModelsContext): Promise<ChatModelConfig[]> {
  if (!context.allowNetwork) {
    // Cache-only phase: restore the persisted catalog when present;
    // otherwise keep the static fallback (re-applying it is a no-op).
    return restoreStored(context);
  }

  const checkedAt = context.stored?.checkedAt;
  if (
    !context.force &&
    typeof checkedAt === "number" &&
    Date.now() - checkedAt < REFRESH_INTERVAL_MS
  ) {
    // Fresh snapshot: skip the network round-trip and keep the restored
    // list.
    return restoreStored(context);
  }

  const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
  const remote = await fetchRemoteCatalog(context.signal, apiKey);
  // pi discards the returned list once the signal is aborted, but the
  // type requires an array; returning the fallback is harmless.
  if (context.signal.aborted) return TEXT_MODELS;

  const models = remote.filter(isChatModel).map(remoteToChatConfig);
  if (models.length === 0) {
    // A chat-empty catalog is almost certainly an API anomaly; rejecting
    // it lets pi keep the previous list instead of registering nothing.
    throw new Error(`Agnes ${MODELS_PATH} returned no chat models`);
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
  // Token billing provider — pricing unpublished, so cost is 0.
  // Update when Agnes publishes official token pricing.
  pi.registerProvider("agnes", {
    name: "Agnes AI",
    baseUrl: BASE_URL,
    apiKey: "$AGNES_API_KEY",
    api: "openai-completions",
    models: TEXT_MODELS,
    refreshModels,
  });

  // Subscription plan provider — cost = 0.
  pi.registerProvider("agnes-plan", {
    name: "Agnes AI (Token Plan)",
    baseUrl: BASE_URL,
    apiKey: "$AGNES_PLAN_API_KEY",
    api: "openai-completions",
    models: TEXT_MODELS,
    refreshModels,
  });
}
