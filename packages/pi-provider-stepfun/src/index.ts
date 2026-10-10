/**
 * pi-provider-stepfun
 *
 * Registers two StepFun (阶跃星辰) providers covering both billing channels,
 * both via pi's built-in openai-completions transport:
 *
 *  - `stepfun`       — pay-as-you-go  (api.stepfun.com/v1)
 *  - `stepfun-plan`  — Step Plan      (api.stepfun.com/step_plan/v1)
 *
 * Both channels accept the same API key; the model sets differ:
 *  - stepfun      has step-1o-turbo-vision (32K, vision, non-reasoning)
 *  - stepfun-plan has step-router-v1 (deepseek-v4-pro or step-3.7-flash)
 *  - step-5-preview and the three Step 3.x Flash models are shared
 *
 * Each registration refreshes its own channel catalog (`GET <base>/models`)
 * when the persisted snapshot is stale (4-hour window, matching pi's
 * built-in remote catalog); `pi update --models` forces an immediate
 * refresh. The response shape is UNVERIFIED (no API key at hand) — the
 * parser accepts the common OpenAI-compatible dialects and prefers
 * shipped specs for every field the catalog omits; on any mismatch the
 * refresh throws and pi keeps the static lists below.
 *
 * Compat for the original models was verified against the live API
 * (see ../../../PROVIDER.md):
 *  - `system` and `developer` roles both accepted
 *  - reasoning via standard `reasoning_effort` (low/medium/high)
 *  - Chat Completions documents `max_tokens` for output limits
 *  - thinking echoed in both `reasoning` and `reasoning_content` (transport
 *    auto-dedupes via its reasoningFields list)
 *  - streaming carries usage on every chunk
 *  - tool calls use standard OpenAI shape; streamed arguments arrive whole
 *  - context overflow returns OpenAI-style `context_length_exceeded` (HTTP 400)
 *  - step-router-v1 emits an `[Advisor consultation]` planning block in `content`;
 *    its tool_calls are otherwise standard OpenAI shape
 *
 * Step 5 Preview follows the published Chat Completions contract but still
 * needs a live wire-contract check.
 */
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Chat-model branch of the `ProviderModelConfig` union. */
type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

const REFRESH_TIMEOUT_MS = 10_000;
/** Freshness window matching pi's built-in remote catalog (4 hours). */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

const STANDARD_BASE = "https://api.stepfun.com/v1";
const PLAN_BASE = "https://api.stepfun.com/step_plan/v1";
const API_KEY_ENV = "STEP_API_KEY";
const PLAN_API_KEY_ENV = "STEP_PLAN_API_KEY";

// ── Types ─────────────────────────────────────────────────────────────────

interface ModelMeta {
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  compat?: Partial<OpenAICompletionsCompat>;
  thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Default compat. StepFun follows the OpenAI Chat Completions contract closely,
 * with explicit output-limit field selection:
 *  - supportsDeveloperRole: both `system` and `developer` are accepted
 *  - supportsReasoningEffort: emit standard `reasoning_effort`
 *  - maxTokensField: StepFun documents `max_tokens`, not `max_completion_tokens`
 * No thinkingFormat is set — the default branch sends OpenAI-style
 * reasoning_effort, and the transport reads `reasoning`/`reasoning_content`
 * generically regardless of format.
 */
const DEFAULT_COMPAT: OpenAICompletionsCompat = {
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
};

// Keep pi's extra thinking levels within StepFun's documented low/medium/high set.
const THINKING_LEVELS: ThinkingLevelMap = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

// Shared across both channels
const SHARED_MODELS: Record<string, ModelMeta> = {
  "step-5-preview": {
    name: "Step 5 Preview",
    contextWindow: 1_000_000,
    // pi reserves maxTokens inside the context window; the API advertises
    // up to 1M output, but using that value here would leave no input room.
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
    compat: { supportsDeveloperRole: false },
  },
  "step-3.7-flash": {
    name: "Step 3.7 Flash",
    contextWindow: 262_144,
    maxTokens: 16_384,
    reasoning: true,
    input: ["text", "image"],
  },
  "step-3.5-flash": {
    name: "Step 3.5 Flash",
    contextWindow: 262_144,
    maxTokens: 16_384,
    reasoning: true,
    input: ["text"],
  },
  // Agent/Coding-optimized snapshot of step-3.5-flash (faster, lower token use).
  "step-3.5-flash-2603": {
    name: "Step 3.5 Flash 2603",
    contextWindow: 262_144,
    maxTokens: 16_384,
    reasoning: true,
    input: ["text"],
    thinkingLevelMap: { ...THINKING_LEVELS, medium: "low" },
  },
};

// Pay-as-you-go channel only
const STANDARD_ONLY: Record<string, ModelMeta> = {
  "step-1o-turbo-vision": {
    name: "Step 1o Turbo Vision",
    contextWindow: 32_768,
    maxTokens: 8_192,
    reasoning: false,
    input: ["text", "image"],
  },
};

// Step Plan channel only; the routed engines have different context limits.
const PLAN_ONLY: Record<string, ModelMeta> = {
  "step-router-v1": {
    name: "Step Router V1",
    contextWindow: 1_048_576,
    maxTokens: 16_384,
    reasoning: true,
    input: ["text"],
  },
};

// StepFun bills in CNY; like other CN providers in this repo, cost is left at 0
// and official pricing is documented in the README.
const COST_ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// ── Model config builder ──────────────────────────────────────────────────

function buildModels(...maps: Record<string, ModelMeta>[]) {
  const merged: Record<string, ModelMeta> = Object.assign({}, ...maps);
  return Object.entries(merged).map(([id, m]) => ({
    id,
    name: m.name,
    api: "openai-completions" as const,
    reasoning: m.reasoning,
    input: m.input,
    cost: COST_ZERO,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: { ...DEFAULT_COMPAT, ...(m.compat ?? {}) },
    ...(m.reasoning ? { thinkingLevelMap: m.thinkingLevelMap ?? THINKING_LEVELS } : {}),
  }));
}

const STANDARD_MODELS = buildModels(SHARED_MODELS, STANDARD_ONLY);
const PLAN_MODELS = buildModels(SHARED_MODELS, PLAN_ONLY);

// ── Dynamic catalog refresh ─────────────────────────────────────────────

type RefreshModelsContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];
type ModelsStoreEntry = NonNullable<Parameters<RefreshModelsContext["publish"]>[0]["persist"]>;

/**
 * `GET <base>/models` catalog entry. The response shape is unverified —
 * accept the common OpenAI-compatible metadata dialects and prefer shipped
 * specs for anything the catalog omits.
 */
interface RemoteModel {
  id: string;
  name?: string;
  context_length?: number | null;
  context_window?: number | null;
  max_output_length?: number | null;
  max_output?: number | null;
  input_modalities?: string[];
  output_modalities?: string[];
}

const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 16_384;

/** Chat models only, when the catalog carries modality info. */
function isChatModel(model: RemoteModel): boolean {
  const output = model.output_modalities;
  if (Array.isArray(output)) return output.includes("text");
  return true; // no modality info — no id-prefix families are known here
}

function remoteToChatConfig(model: RemoteModel, knownById: Map<string, ChatModelConfig>): ChatModelConfig {
  const known = knownById.get(model.id);
  const ctx = [model.context_length, model.context_window].find((v) => typeof v === "number");
  const out = [model.max_output_length, model.max_output].find((v) => typeof v === "number");
  return {
    id: model.id,
    name: model.name || known?.name || model.id,
    reasoning: known?.reasoning ?? true,
    input: (model.input_modalities ?? known?.input ?? ["text"]).filter(
      (m) => m === "text" || m === "image",
    ) as ("text" | "image")[],
    cost: COST_ZERO,
    contextWindow: ctx ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: out ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...((known?.reasoning ?? true) ? { thinkingLevelMap: known?.thinkingLevelMap ?? THINKING_LEVELS } : {}),
    compat: known?.compat ?? DEFAULT_COMPAT,
  };
}

/** Convert a persisted catalog entry (pi model objects) back to chat configs. */
function storedToChatConfigs(
  models: readonly unknown[],
  knownById: Map<string, ChatModelConfig>,
): ChatModelConfig[] {
  const configs: ChatModelConfig[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (m.type !== undefined && m.type !== "chat") continue; // image/classifier entries
    const id = typeof m.id === "string" ? m.id : "";
    if (!id) continue;
    const known = knownById.get(id);
    configs.push({
      id,
      name: typeof m.name === "string" ? m.name : (known?.name ?? id),
      reasoning: typeof m.reasoning === "boolean" ? m.reasoning : (known?.reasoning ?? true),
      input: (Array.isArray(m.input) ? m.input : (known?.input ?? ["text"])) as ("text" | "image")[],
      cost: COST_ZERO,
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : (known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
      maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : (known?.maxTokens ?? DEFAULT_MAX_TOKENS),
      ...((typeof m.reasoning === "boolean" ? m.reasoning : (known?.reasoning ?? true))
        ? { thinkingLevelMap: (m.thinkingLevelMap ?? known?.thinkingLevelMap ?? THINKING_LEVELS) as ChatModelConfig["thinkingLevelMap"] }
        : {}),
      compat: (m.compat ?? known?.compat ?? DEFAULT_COMPAT) as ChatModelConfig["compat"],
    });
  }
  return configs;
}

async function fetchRemoteCatalog(
  modelsUrl: string,
  providerId: string,
  apiKeyEnv: string,
  signal: AbortSignal,
  apiKey: string | undefined,
): Promise<RemoteModel[]> {
  if (!apiKey) throw new Error(`${apiKeyEnv} is not configured for ${providerId}`);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`StepFun ${modelsUrl} returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: RemoteModel[] };
    if (!Array.isArray(body?.data)) {
      throw new Error(`StepFun ${modelsUrl} returned an unexpected response shape`);
    }
    return body.data;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Two-phase refresh driven by pi on startup, per registration (each channel
 * has its own base URL, credential and catalog):
 *
 * - Offline phase (`allowNetwork: false`): restore the persisted catalog
 *   when present, otherwise leave the channel's static list in place.
 * - Network phase (`allowNetwork: true`): skip the fetch while the
 *   persisted snapshot is younger than `REFRESH_INTERVAL_MS` (parity with
 *   pi's built-in remote catalog); `force` (e.g. `pi update --models`)
 *   bypasses the window. On failure pi keeps the previous list.
 */
function makeRefreshModels(options: {
  baseUrl: string;
  providerId: string;
  apiKeyEnv: string;
  fallback: ChatModelConfig[];
}) {
  const modelsUrl = `${options.baseUrl}/models`;
  const knownById = new Map(options.fallback.map((m) => [m.id, m]));
  const restoreStored = (context: RefreshModelsContext): ChatModelConfig[] => {
    const stored = context.stored?.models;
    return stored?.length ? storedToChatConfigs(stored, knownById) : options.fallback;
  };
  return async function refreshModels(context: RefreshModelsContext): Promise<ChatModelConfig[]> {
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
    const remote = await fetchRemoteCatalog(modelsUrl, options.providerId, options.apiKeyEnv, context.signal, apiKey);
    // pi discards the returned list once the signal is aborted, but the
    // type requires an array; returning the fallback is harmless.
    if (context.signal.aborted) return options.fallback;

    const models = remote.filter(isChatModel).map((m) => remoteToChatConfig(m, knownById));
    if (models.length === 0) {
      // A chat-empty catalog is almost certainly an API anomaly; rejecting
      // it lets pi keep the previous list instead of registering nothing.
      throw new Error(`StepFun ${modelsUrl} returned no chat models`);
    }

    await context.publish({
      persist: {
        models: models as unknown as ModelsStoreEntry["models"],
        checkedAt: Date.now(),
      },
    });

    return models;
  };
}

const refreshStandard = makeRefreshModels({
  baseUrl: STANDARD_BASE,
  providerId: "stepfun",
  apiKeyEnv: API_KEY_ENV,
  fallback: STANDARD_MODELS,
});
const refreshPlan = makeRefreshModels({
  baseUrl: PLAN_BASE,
  providerId: "stepfun-plan",
  apiKeyEnv: PLAN_API_KEY_ENV,
  fallback: PLAN_MODELS,
});

// ── Entry point ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Pay-as-you-go channel
  pi.registerProvider("stepfun", {
    name: "StepFun",
    baseUrl: STANDARD_BASE,
    apiKey: `$${API_KEY_ENV}`,
    api: "openai-completions",
    authHeader: true,
    models: STANDARD_MODELS,
    refreshModels: refreshStandard,
  });

  // Step Plan subscription channel (adds step-router-v1)
  pi.registerProvider("stepfun-plan", {
    name: "StepFun (Step Plan)",
    baseUrl: PLAN_BASE,
    apiKey: `$${PLAN_API_KEY_ENV}`,
    api: "openai-completions",
    authHeader: true,
    models: PLAN_MODELS,
    refreshModels: refreshPlan,
  });
}
