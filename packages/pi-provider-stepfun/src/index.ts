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
 *  - stepfun-plan has step-router-v1 (1M, auto-routes deepseek-v4-pro ↔ step-3.5-flash)
 *  - the three Step 3.x Flash models are shared
 *
 * Compat verified against the live API (see ../../PROVIDER.md):
 *  - `system` and `developer` roles both accepted
 *  - reasoning via standard `reasoning_effort` (low/medium/high)
 *  - thinking echoed in both `reasoning` and `reasoning_content` (transport
 *    auto-dedupes via its reasoningFields list)
 *  - streaming carries usage on every chunk
 *  - tool calls use standard OpenAI shape; streamed arguments arrive whole
 *  - context overflow returns OpenAI-style `context_length_exceeded` (HTTP 400)
 *  - step-router-v1 emits an `[Advisor consultation]` planning block in `content`;
 *    its tool_calls are otherwise standard OpenAI shape
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";

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
}

/**
 * Default compat. StepFun follows the OpenAI Chat Completions contract closely,
 * so only two flags are needed — verified identical on both channels:
 *  - supportsDeveloperRole: both `system` and `developer` are accepted
 *  - supportsReasoningEffort: emit standard `reasoning_effort`
 * No thinkingFormat is set — the default branch sends OpenAI-style
 * reasoning_effort, and the transport reads `reasoning`/`reasoning_content`
 * generically regardless of format.
 */
const DEFAULT_COMPAT: OpenAICompletionsCompat = {
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
};

// Shared across both channels
const FLASH_MODELS: Record<string, ModelMeta> = {
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

// Step Plan channel only — routing model, 1M context, 384K max output per docs
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
  }));
}

const STANDARD_MODELS = buildModels(FLASH_MODELS, STANDARD_ONLY);
const PLAN_MODELS = buildModels(FLASH_MODELS, PLAN_ONLY);

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
  });

  // Step Plan subscription channel (adds step-router-v1)
  pi.registerProvider("stepfun-plan", {
    name: "StepFun (Step Plan)",
    baseUrl: PLAN_BASE,
    apiKey: `$${PLAN_API_KEY_ENV}`,
    api: "openai-completions",
    authHeader: true,
    models: PLAN_MODELS,
  });
}
