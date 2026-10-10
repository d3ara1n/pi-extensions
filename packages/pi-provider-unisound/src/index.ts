/**
 * pi-provider-unisound
 *
 * Registers two Unisound (云知声) MaaS providers covering both billing
 * channels, both via pi's built-in openai-completions transport:
 *
 *  - `unisound`       — pay-as-you-go (maas-api.unisound.com/v1, $UNISOUND_API_KEY)
 *  - `unisound-plan`  — Token Plan subscription ($UNISOUND_PLAN_API_KEY)
 *
 * Both channels expose the SAME platform model set — they differ only in
 * billing, not in model entitlement (permissions live on the key: a
 * u2-flash-only trial key simply cannot call the other models). Token Plan
 * keys are dedicated (not interchangeable with pay-as-you-go keys) and may
 * only be used inside coding tools — not for non-coding automation.
 *
 * The model catalog is refreshed from the live API (`GET /v1/models`) when
 * the persisted snapshot is stale (4-hour window, matching pi's built-in
 * remote catalog) and restored from the snapshot on offline startups; `pi
 * update --models` forces an immediate refresh. The endpoint returns the
 * platform-wide listing regardless of key permissions (verified live), so
 * the catalog is taken as-is. `context_window` / `max_output` come from the
 * catalog; modalities, thinking behavior and pricing are not exposed by the
 * endpoint and fall back to the shipped specs below per model id.
 *
 * Compat: `u2-flash` was verified against the live API (see README and
 * ../../PROVIDER.md; re-checked 2026-09-30 after the U2-Flash release).
 * The remaining models follow the same wire contract per official docs but
 * were NOT live-tested — per-model thinking behavior still differs and is
 * encoded from the documented constraints below.
 *
 * Usage quota/balance reporting is not yet implemented — Unisound MaaS does
 * not currently expose a public quota or balance API (dashboard/billing,
 * /v1/me, /v1/balance, /v1/quota all return 404; no quota headers either).
 * When one becomes available, integrate via @d3ara1n/pi-usage-block-core.
 */
import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

/** Chat-model branch of the `ProviderModelConfig` union. */
type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

// ── Constants ─────────────────────────────────────────────────────────────

const BASE_URL = "https://maas-api.unisound.com/v1";
const MODELS_PATH = `${BASE_URL}/models`;
const API_KEY_ENV = "UNISOUND_API_KEY";
const PLAN_API_KEY_ENV = "UNISOUND_PLAN_API_KEY";
const REFRESH_TIMEOUT_MS = 10_000;
/** Freshness window matching pi's built-in remote catalog (4 hours). */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

// ── Compat ────────────────────────────────────────────────────────────────

/**
 * Shared contract, live-verified on u2-flash:
 *  - roles: system/user/assistant/tool only (`developer` → 400)
 *  - max_tokens: documented field name (max_completion_tokens tolerated)
 *  - streaming: standard OpenAI SSE; usage on a final empty-choices chunk
 *    with stream_options.include_usage; tool deltas standard OpenAI shape
 *  - store: false / tool strict: false accepted
 *  - thinking: `thinking: { type: "enabled" | "disabled" }` (pi "deepseek"
 *    format), on by default
 */
const UNISOUND_COMPAT = {
  supportsDeveloperRole: false,
  // The gateway enum-validates reasoning_effort platform-wide (none/minimal/
  // low/medium/high/xhigh/max), but validating ≠ honoring: u2-flash ignores
  // it (re-verified live 2026-09-30 — effort high/low/none leave reasoning
  // unchanged; the "four-level reasoning intensity" touted in the U2-Flash
  // launch announcement is not exposed through this API), and u2 is absent
  // from the docs effort table. Models that honor it (u2-med, plus glm-5.2 /
  // kimi-k3 in the Token Plan) override this per model.
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens" as const,
  thinkingFormat: "deepseek" as const,
};

// Models without effort levels: reasoning toggles on/off, nothing between.
const THINKING_TOGGLE = {
  off: "disabled",
  minimal: null,
  low: null,
  medium: null,
  high: "enabled",
} as const;

// u2: thinking is on by default and cannot be disabled (docs) — hide "off".
const THINKING_ALWAYS_ON = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: "enabled",
} as const;

// glm-5.2 / DeepSeek V4 convention (zai.json / deepseek.json native entries
// agree): high/max only — low/medium are gateway aliases, hidden per repo
// convention. Thinking can be disabled via thinking.type.
const THINKING_EFFORT_HIGH_MAX = {
  off: "disabled",
  minimal: null, // alias of high
  low: null, // alias of high
  medium: null, // alias of high
  high: "high",
  xhigh: null, // alias of high
  max: "max",
} as const;

// glm-5.3 family (opencode-go reference entry): low/high/max.
const THINKING_EFFORT_LOW_HIGH_MAX = {
  off: "disabled",
  minimal: null, // alias of low
  low: "low",
  medium: null, // alias of high
  high: "high",
  xhigh: null, // alias of high
  max: "max",
} as const;

// kimi-k3 (moonshotai.json native): low/high/max, always thinking — off is
// null; medium unsupported → hidden.
const THINKING_KIMI = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
} as const;

const EFFORT_COMPAT = { ...UNISOUND_COMPAT, supportsReasoningEffort: true };

// ── Model specs ───────────────────────────────────────────────────────────
//
// One shared spec table for both channels (same platform model set,
// verified against `GET /v1/models` 2026-10-10). Third-party model-level
// truth (modalities, thinking levels) is cross-referenced from pi's
// built-in catalog entries per ../../PROVIDER.md; entries without a usable
// reference default to the u2-flash-verified toggle contract.

// pi tracks cost in USD; Unisound lists CNY per million tokens (u2-flash
// has run launch discounts and a 2026-09/10 free month, all excluded per
// repo pricing rules). Converted at ~7.1 CNY/USD for display estimates
// only — not real billing. List prices incl. cache-hit (re-checked on the
// model hub 2026-09-30): flash ¥1/0.2/2, u2 ¥1/0.02/2, u2-med ¥8/2/28
// (input/cache/output). Cache-write pricing is not published anywhere.
// Third-party model pricing on this gateway is unpublished → 0 per rules.
const PAYG_COSTS: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "u2-flash": { input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0 },
  u2: { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 },
  "u2-med": { input: 1.13, output: 3.94, cacheRead: 0.28, cacheWrite: 0 },
};

// Subscription billing → cost 0 per repo pricing rules.
const PLAN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

interface ModelSpec {
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ChatModelConfig["thinkingLevelMap"];
  compat?: ChatModelConfig["compat"];
}

const MODEL_SPECS: Record<string, ModelSpec> = {
  "u2-flash": {
    // Verified live (last re-checked 2026-09-30): thinking toggles,
    // reasoning_effort is accepted but ignored, text-only.
    // /v1/models reports contextWindow/maxOutput = 524288/131072; the
    // gateway actually admits inputs up to 1,024,000 tokens, but the
    // advertised spec is declared so pi compacts conservatively.
    name: "U2 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 524_288,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  u2: {
    // Docs: thinking on by default, cannot be disabled. 160K/64K per
    // /v1/models and model hub.
    name: "U2",
    reasoning: true,
    input: ["text"],
    contextWindow: 160_000,
    maxTokens: 64_000,
    thinkingLevelMap: THINKING_ALWAYS_ON,
    compat: UNISOUND_COMPAT,
  },
  "u2-med": {
    // Docs put u2-med in neither the can't-disable nor can't-enable group,
    // so thinking.type toggles like u2-flash. Per the 2026-09 docs it also
    // honors reasoning_effort: native levels none/low/medium/high, with
    // minimal→low and xhigh/max→high as gateway aliases (hidden per repo
    // convention). Not live-tested — the dev key has no u2-med permission.
    // Max output is unpublished (/v1/models returns null) — 64K is a
    // conservative placeholder. Medical imaging model: image+text input.
    name: "U2 Med",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    thinkingLevelMap: {
      off: "disabled",
      minimal: null, // alias of low
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null, // alias of high
      max: null, // alias of high
    },
    compat: EFFORT_COMPAT,
  },
  // u2-radimed: absent from /v1/models since at least 2026-10-10 — removed
  // (catalog is authoritative). If it returns, refresh re-registers it with
  // the generic u2 defaults.
  "glm-5.2": {
    // Docs + pi built-in native entries (zai.json) agree on high/max only;
    // reasoning_effort honored per Token Plan docs.
    name: "GLM-5.2",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_EFFORT_HIGH_MAX,
    compat: EFFORT_COMPAT,
  },
  "glm-5.3": {
    // opencode-go reference: low/high/max; catalog 1M/131072.
    name: "GLM-5.3",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_EFFORT_LOW_HIGH_MAX,
    compat: EFFORT_COMPAT,
  },
  "glm-5.3-flash": {
    // opencode-go reference: low/high/max, image input.
    name: "GLM-5.3 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_EFFORT_LOW_HIGH_MAX,
    compat: EFFORT_COMPAT,
  },
  "glm-5.1": {
    // No usable thinking-level reference → conservative toggle contract.
    name: "GLM-5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 202_000,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "glm-5": {
    // No usable thinking-level reference → conservative toggle contract.
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 202_000,
    maxTokens: 16_000,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "kimi-k3": {
    // moonshotai.json native: low/high/max, always thinking; image input.
    name: "Kimi K3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 1_048_576,
    thinkingLevelMap: THINKING_KIMI,
    compat: EFFORT_COMPAT,
  },
  "kimi-k2.5": {
    // opencode reference: image input; levels unknown → toggle.
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 16_000,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "kimi-k2.6": {
    // moonshotai-cn native: image input; levels unknown → toggle.
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 16_000,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "deepseek-v4-flash-0731": {
    // qwen-token-plan-cn reference: high/max.
    name: "DeepSeek V4 Flash 0731",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 393_216,
    thinkingLevelMap: THINKING_EFFORT_HIGH_MAX,
    compat: EFFORT_COMPAT,
  },
  "deepseek-v4-pro": {
    // deepseek native: high/max.
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 384_000,
    thinkingLevelMap: THINKING_EFFORT_HIGH_MAX,
    compat: EFFORT_COMPAT,
  },
  "qwen3.8-max": {
    // opencode-go reference lists low/medium/xhigh — an inconsistent level
    // set; treat levels as unknown → toggle.
    name: "Qwen3.8 Max",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "qwen3.8-flash": {
    name: "Qwen3.8 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "qwen3.7-max": {
    name: "Qwen3.7 Max",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "qwen3.7-plus": {
    name: "Qwen3.7 Plus",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "qwen3.6-plus": {
    name: "Qwen3.6 Plus",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_000,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "qwen3.6-flash": {
    name: "Qwen3.6 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_000,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "qwen3.6-35b-a3b": {
    // No built-in reference entry at all → toggle + text-only.
    name: "Qwen3.6 35B A3B",
    reasoning: true,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 65_000,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "MiniMax-M2.5": {
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 204_800,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  "MiniMax-M3": {
    name: "MiniMax M3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 524_288,
    maxTokens: 1_048_576,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
};

function buildModels(channel: "payg" | "plan"): ChatModelConfig[] {
  return Object.entries(MODEL_SPECS).map(([id, spec]) => ({
    id,
    name: spec.name,
    reasoning: spec.reasoning,
    input: spec.input,
    cost: channel === "plan" ? PLAN_COST : (PAYG_COSTS[id] ?? ZERO_COST),
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    ...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
    ...(spec.compat ? { compat: spec.compat } : {}),
  }));
}

const PAYG_MODELS = buildModels("payg");
const PLAN_MODELS = buildModels("plan");

// ── Dynamic catalog refresh ───────────────────────────────────────────────

type RefreshModelsContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];
type ModelsStoreEntry = NonNullable<Parameters<RefreshModelsContext["publish"]>[0]["persist"]>;

/** `GET /v1/models` catalog entry (OpenAI-compatible plus Unisound metadata). */
interface RemoteModel {
  id: string;
  name?: string;
  context_window?: number | null;
  max_output?: number | null;
}

/** Shipped specs by model id, used to fill gaps in live catalog entries. */
const KNOWN_SPECS = new Map(Object.entries(MODEL_SPECS));

const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 65_536;

function remoteToChatConfig(model: RemoteModel, channel: "payg" | "plan"): ChatModelConfig {
  const known = KNOWN_SPECS.get(model.id);
  return {
    id: model.id,
    name: model.name || known?.name || model.id,
    reasoning: known?.reasoning ?? true,
    input: known?.input ?? ["text"],
    cost: channel === "plan" ? PLAN_COST : (PAYG_COSTS[model.id] ?? ZERO_COST),
    contextWindow:
      typeof model.context_window === "number" ? model.context_window : (known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    maxTokens: typeof model.max_output === "number" ? model.max_output : (known?.maxTokens ?? DEFAULT_MAX_TOKENS),
    ...(known?.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : { thinkingLevelMap: THINKING_TOGGLE }),
    ...(known?.compat ? { compat: known.compat } : { compat: UNISOUND_COMPAT }),
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
      input: (Array.isArray(m.input) ? m.input : (known?.input ?? ["text"])) as ("text" | "image")[],
      cost: (m.cost ?? ZERO_COST) as ChatModelConfig["cost"],
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : (known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
      maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : (known?.maxTokens ?? DEFAULT_MAX_TOKENS),
      thinkingLevelMap: (m.thinkingLevelMap ?? known?.thinkingLevelMap ?? THINKING_TOGGLE) as ChatModelConfig["thinkingLevelMap"],
      compat: (m.compat ?? known?.compat ?? UNISOUND_COMPAT) as ChatModelConfig["compat"],
    });
  }
  return configs;
}

async function fetchRemoteCatalog(signal: AbortSignal, apiKey: string | undefined): Promise<RemoteModel[]> {
  if (!apiKey) throw new Error(`${API_KEY_ENV} is not configured for unisound`);
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
      throw new Error(`Unisound ${MODELS_PATH} returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: RemoteModel[] };
    if (!Array.isArray(body?.data)) {
      throw new Error(`Unisound ${MODELS_PATH} returned an unexpected response shape`);
    }
    return body.data;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** Restore the persisted catalog when present; otherwise the static fallback. */
function restoreStored(context: RefreshModelsContext, channel: "payg" | "plan"): ChatModelConfig[] {
  const stored = context.stored?.models;
  // pi's models-store is keyed by provider id, so each registration reads
  // its own snapshot (published by its own refresh, channel costs intact);
  // cost is re-resolved defensively in case a store entry predates a
  // channel-cost change in the shipped table.
  const restored = stored?.length ? storedToChatConfigs(stored) : [];
  if (!restored.length) return channel === "plan" ? PLAN_MODELS : PAYG_MODELS;
  return restored.map((m) => ({ ...m, cost: channel === "plan" ? PLAN_COST : (PAYG_COSTS[m.id] ?? ZERO_COST) }));
}

/**
 * Two-phase refresh driven by pi on startup, per registration:
 *
 * - Offline phase (`allowNetwork: false`): restore the persisted catalog
 *   when present, otherwise leave the channel's static list in place.
 * - Network phase (`allowNetwork: true`): skip the fetch while the
 *   persisted snapshot is younger than `REFRESH_INTERVAL_MS` (parity with
 *   pi's built-in remote catalog); `force` (e.g. `pi update --models`)
 *   bypasses the window. Otherwise fetch `GET /v1/models` with the
 *   registration's credential, persist a snapshot for offline startups,
 *   and replace the live model list. On failure pi keeps the previous
 *   list.
 */
function makeRefreshModels(channel: "payg" | "plan") {
  return async function refreshModels(context: RefreshModelsContext): Promise<ChatModelConfig[]> {
    if (!context.allowNetwork) {
      // Cache-only phase: restore the persisted catalog when present;
      // otherwise keep the static fallback (re-applying it is a no-op).
      return restoreStored(context, channel);
    }

    const checkedAt = context.stored?.checkedAt;
    if (
      !context.force &&
      typeof checkedAt === "number" &&
      Date.now() - checkedAt < REFRESH_INTERVAL_MS
    ) {
      // Fresh snapshot: skip the network round-trip and keep the restored
      // list.
      return restoreStored(context, channel);
    }

    const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
    const remote = await fetchRemoteCatalog(context.signal, apiKey);
    // pi discards the returned list once the signal is aborted, but the
    // type requires an array; returning the fallback is harmless.
    if (context.signal.aborted) return channel === "plan" ? PLAN_MODELS : PAYG_MODELS;

    // The endpoint lists the platform catalog regardless of key
    // permissions — taken as-is (catalog is authoritative). Every entry is
    // a chat model today; a future non-chat entry would need a filter.
    const models = remote.map((m) => remoteToChatConfig(m, channel));
    if (models.length === 0) {
      // A chat-empty catalog is almost certainly an API anomaly; rejecting
      // it lets pi keep the previous list instead of registering nothing.
      throw new Error(`Unisound ${MODELS_PATH} returned no models`);
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

const refreshPayg = makeRefreshModels("payg");
const refreshPlan = makeRefreshModels("plan");

// ── Entry point ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Pay-as-you-go channel (Metered & Packs API key)
  pi.registerProvider("unisound", {
    name: "Unisound MaaS",
    baseUrl: BASE_URL,
    apiKey: `$${API_KEY_ENV}`,
    api: "openai-completions",
    authHeader: true,
    models: PAYG_MODELS,
    refreshModels: refreshPayg,
  });

  // Token Plan subscription channel (dedicated API key, coding tools only)
  pi.registerProvider("unisound-plan", {
    name: "Unisound MaaS (Token Plan)",
    baseUrl: BASE_URL,
    apiKey: `$${PLAN_API_KEY_ENV}`,
    api: "openai-completions",
    authHeader: true,
    models: PLAN_MODELS,
    refreshModels: refreshPlan,
  });
}
