/**
 * pi-provider-unisound
 *
 * Registers two Unisound (云知声) MaaS providers covering both billing
 * channels, both via pi's built-in openai-completions transport:
 *
 *  - `unisound`       — pay-as-you-go (maas-api.unisound.com/v1, $UNISOUND_API_KEY)
 *  - `unisound-plan`  — Token Plan subscription ($UNISOUND_PLAN_API_KEY)
 *
 * Token Plan keys are dedicated (not interchangeable with pay-as-you-go keys)
 * and may only be used inside coding tools — not for non-coding automation.
 * The Token Plan docs do not document a separate base URL, so the plan
 * provider uses the same endpoint; adjust if a plan key proves otherwise.
 *
 * Compat: `u2-flash` was verified against the live API (see README and
 * ../../PROVIDER.md; re-checked 2026-09-30 after the U2-Flash release).
 * The remaining models follow the same wire contract per official docs but
 * were NOT live-tested (the dev key only has u2-flash permission) —
 * per-model thinking behavior still differs and is encoded from the
 * documented constraints below.
 *
 * Usage quota/balance reporting is not yet implemented — Unisound MaaS does
 * not currently expose a public quota or balance API (dashboard/billing,
 * /v1/me, /v1/balance, /v1/quota all return 404; no quota headers either).
 * When one becomes available, integrate via @d3ara1n/pi-usage-block-core.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Constants ─────────────────────────────────────────────────────────────

const BASE_URL = "https://maas-api.unisound.com/v1";
const API_KEY_ENV = "UNISOUND_API_KEY";
const PLAN_API_KEY_ENV = "UNISOUND_PLAN_API_KEY";

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

// U2 models without effort levels: reasoning toggles on/off, nothing between.
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

// ── Models ────────────────────────────────────────────────────────────────

// pi tracks cost in USD; Unisound lists CNY per million tokens (u2-flash
// has run launch discounts and a 2026-09/10 free month, all excluded per
// repo pricing rules). Converted at ~7.1 CNY/USD for display estimates
// only — not real billing. List prices incl. cache-hit (re-checked on the
// model hub 2026-09-30): flash ¥1/0.2/2, u2 ¥1/0.02/2, u2-med ¥8/2/28,
// u2-radimed ¥15/4/20 (input/cache/output). Cache-write pricing is not
// published anywhere.
const FLASH_COST = { input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0 };
const U2_COST = { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 };
const MED_COST = { input: 1.13, output: 3.94, cacheRead: 0.28, cacheWrite: 0 };
const RADIMED_COST = { input: 2.11, output: 2.82, cacheRead: 0.56, cacheWrite: 0 };

// Subscription billing → cost 0 per repo pricing rules.
const PLAN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ── Pay-as-you-go models (U2 family only; the platform also hosts
// third-party models better served by their native providers) ─────────────

const PAYG_MODELS = [
  {
    // Verified live (last re-checked 2026-09-30): thinking toggles,
    // reasoning_effort is accepted but ignored, text-only.
    id: "u2-flash",
    name: "U2 Flash",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: FLASH_COST,
    // /v1/models reports contextWindow/maxOutput = 524288/131072; the gateway
    // actually admits inputs up to 1,024,000 tokens, but the advertised spec
    // is declared so pi compacts conservatively.
    contextWindow: 524_288,
    maxTokens: 131_072,
    thinkingLevelMap: THINKING_TOGGLE,
    compat: UNISOUND_COMPAT,
  },
  {
    // Docs: thinking on by default, cannot be disabled. 160K/64K per
    // /v1/models and model hub.
    id: "u2",
    name: "U2",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: U2_COST,
    contextWindow: 160_000,
    maxTokens: 64_000,
    thinkingLevelMap: THINKING_ALWAYS_ON,
    compat: UNISOUND_COMPAT,
  },
  {
    // Docs put u2-med in neither the can't-disable nor can't-enable group,
    // so thinking.type toggles like u2-flash. Per the 2026-09 docs it also
    // honors reasoning_effort: native levels none/low/medium/high, with
    // minimal→low and xhigh/max→high as gateway aliases (hidden per repo
    // convention). Not live-tested — the dev key has no u2-med permission.
    // Max output is unpublished (/v1/models returns null) — 64K is a
    // conservative placeholder.
    id: "u2-med",
    name: "U2 Med",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: MED_COST,
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
    compat: { ...UNISOUND_COMPAT, supportsReasoningEffort: true },
  },
  {
    // Docs: thinking disabled by default and cannot be enabled → reasoning
    // false. Medical imaging model: image+text input, 40K context per model
    // hub. Max output unpublished — 8K placeholder. Not in the Token Plan.
    // Still on the model hub and in the docs enum as of 2026-09-30, though
    // /v1/models omits it — keep until officially retired.
    id: "u2-radimed",
    name: "U2 RadiMed",
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: RADIMED_COST,
    contextWindow: 40_960,
    maxTokens: 8_192,
    compat: UNISOUND_COMPAT,
  },
];

// ── Token Plan models (per plan docs, re-checked 2026-09-30: u2-flash, u2,
// u2-med, glm-5.2, kimi-k3 — no u2-radimed). u2-med/glm/kimi honor
// reasoning_effort; u2-flash/u2 do not. ───

const PLAN_ONLY_MODELS = [
  {
    // Docs + pi built-in native entries (zai.json) agree on high/max only:
    // low/medium are gateway aliases for high, so they are hidden (matching
    // the zai.json convention); thinking can be disabled via thinking.type.
    id: "glm-5.2",
    name: "GLM-5.2 (Token Plan)",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: PLAN_COST,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: {
      off: "disabled",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    compat: { ...UNISOUND_COMPAT, supportsReasoningEffort: true },
  },
  {
    // Docs and pi's native moonshotai.json both expose low/high/max (default
    // max, always thinking — off is null; opencode.json's max-only entry is
    // a conservative outlier). medium is unsupported → hidden.
    id: "kimi-k3",
    name: "Kimi K3 (Token Plan)",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: PLAN_COST,
    contextWindow: 1_048_576,
    maxTokens: 1_048_576,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    compat: { ...UNISOUND_COMPAT, supportsReasoningEffort: true },
  },
];

// Pay-as-you-go entries reused in the plan, with subscription cost.
const PLAN_U2_MODELS = PAYG_MODELS.filter((m) => m.id !== "u2-radimed").map(
  (m) => ({ ...m, cost: PLAN_COST }),
);

const PLAN_MODELS = [...PLAN_U2_MODELS, ...PLAN_ONLY_MODELS];

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
  });

  // Token Plan subscription channel (dedicated API key, coding tools only)
  pi.registerProvider("unisound-plan", {
    name: "Unisound MaaS (Token Plan)",
    baseUrl: BASE_URL,
    apiKey: `$${PLAN_API_KEY_ENV}`,
    api: "openai-completions",
    authHeader: true,
    models: PLAN_MODELS,
  });
}
