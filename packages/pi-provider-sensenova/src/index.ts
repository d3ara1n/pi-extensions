/**
 * pi-provider-sensenova
 *
 * Registers "sensenova-plan" provider for SenseNova (商汤日日新) Token Plan.
 *
 * Currently only includes sensenova-6.7-flash-lite — the lightweight
 * multimodal agent model for real-world workflows.
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

// ── Model ─────────────────────────────────────────────────────────────────

const MODELS = [
  {
    id: "sensenova-6.7-flash-lite",
    name: "SenseNova 6.7 Flash-Lite",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // free during beta
    contextWindow: 262_144,
    maxTokens: 65_536,
    // sensenova reasons by default (~560 tokens / ~10s, enough to trip scout's
    // 15s side-agent timeout); only reasoning_effort=none actually disables it.
    thinkingLevelMap: {
      off: "none",
      minimal: null, // rejected with HTTP 400 — only low/medium/high/none valid
      low: "low",
      medium: "medium",
      high: "high",
    },
    compat: {
      supportsDeveloperRole: false, // uses `system` role, not `developer`
      supportsReasoningEffort: true, // required for thinkingLevelMap to emit reasoning_effort
    },
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
