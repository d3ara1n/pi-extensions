/**
 * pi-provider-stepfun
 *
 * Registers the "stepfun" provider (阶跃星辰 / StepFun) with a static
 * model list. Uses pi's built-in openai-completions transport.
 *
 * Compat verified against the live API (see ../../PROVIDER.md):
 *  - `system` and `developer` roles both accepted
 *  - reasoning via standard `reasoning_effort` (low/medium/high)
 *  - thinking echoed in both `reasoning` and `reasoning_content` (transport
 *    auto-dedupes via its reasoningFields list)
 *  - streaming carries usage on every chunk
 *  - tool calls use standard OpenAI shape; streamed arguments arrive whole
 *  - context overflow returns OpenAI-style `context_length_exceeded` (HTTP 400)
 *
 * Auth: API key from $STEP_API_KEY (or /login → auth.json).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";

const PROVIDER_ID = "stepfun";
const PROVIDER_NAME = "StepFun";
const BASE_URL = "https://api.stepfun.com/v1";
const API_KEY_ENV = "STEP_API_KEY";

// ── Types ─────────────────────────────────────────────────────────────────

interface ModelMeta {
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  compat?: Partial<OpenAICompletionsCompat>;
}

// ── Known model metadata ─────────────────────────────────────────────────

/**
 * Default compat applies to every model. StepFun follows the OpenAI Chat
 * Completions contract closely, so only two flags are needed:
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

const KNOWN_MODELS: Record<string, ModelMeta> = {
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
  "step-1o-turbo-vision": {
    name: "Step 1o Turbo Vision",
    contextWindow: 32_768,
    maxTokens: 8_192,
    reasoning: false,
    input: ["text", "image"],
  },
};

// StepFun bills in CNY; like other CN providers in this repo, cost is left at 0
// and official pricing is documented in the README.
const COST_ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// ── Model config builder ──────────────────────────────────────────────────

const MODELS = Object.entries(KNOWN_MODELS).map(([id, m]) => ({
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

// ── Entry point ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    apiKey: `$${API_KEY_ENV}`,
    api: "openai-completions",
    authHeader: true,
    models: MODELS,
  });
}
