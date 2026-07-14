/**
 * pi-provider-sensenova
 *
 * Registers "sensenova-plan" provider for SenseNova (商汤日日新) Token Plan.
 *
 * Registers all Token Plan chat-completions models. Image-generation-only
 * models are intentionally excluded.
 *
 * Usage quota/balance reporting is not yet implemented — SenseNova does not
 * currently expose a public quota or balance API. Free during public beta.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Constants ─────────────────────────────────────────────────────────────

const PROVIDER_ID = "sensenova-plan";
const PROVIDER_NAME = "SenseNova (Token Plan)";
const BASE_URL = "https://token.sensenova.cn/v1";
const API_KEY_ENV = "SENSENOVA_API_KEY";

// ── Models ────────────────────────────────────────────────────────────────

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

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

const MODELS = [
  {
    id: "sensenova-6.7-flash-lite",
    name: "SenseNova 6.7 Flash-Lite",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: COST,
    contextWindow: 262_144,
    maxTokens: 65_536,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: COST,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    thinkingLevelMap: REASONING,
    compat: CHAT_COMPAT,
  },
];

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
