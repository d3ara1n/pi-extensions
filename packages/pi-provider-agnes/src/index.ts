/**
 * pi-provider-agnes
 *
 * Registers two Agnes AI providers:
 * - `agnes`      — token billing (future); cost uses legacy per-token pricing as placeholder
 * - `agnes-plan` — subscription plan; cost = 0
 *
 * Both share the same base URL and model list (text models only).
 *
 * Usage quota/balance reporting is not yet implemented — Agnes AI does not
 * currently expose a public quota or balance API. When one becomes available,
 * integrate via pi-usage-block-core (see plans/pi-provider-agnes.md).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Constants ─────────────────────────────────────────────────────────────

const BASE_URL = "https://apihub.agnes-ai.com/v1";

// ── Models (text only) ────────────────────────────────────────────────────

interface TextModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

const TEXT_MODELS: TextModelDef[] = [
  {
    id: "agnes-2.0-flash",
    name: "Agnes 2.0 Flash",
    reasoning: true,
    contextWindow: 256_000,
    maxTokens: 64_000,
  },
  {
    id: "agnes-1.5-flash",
    name: "Agnes 1.5 Flash",
    reasoning: false,
    contextWindow: 256_000,
    maxTokens: 64_000,
  },
];

// ── Entry point ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Token billing provider — cost uses legacy per-token pricing as placeholder.
  // Update when Agnes introduces official token pricing.
  pi.registerProvider("agnes", {
    name: "Agnes AI",
    baseUrl: BASE_URL,
    apiKey: "$AGNES_API_KEY",
    api: "openai-completions",
    models: TEXT_MODELS.map((m) => ({
      ...m,
      input: ["text", "image"] as const,
      cost: { input: 0.03, output: 0.15, cacheRead: 0, cacheWrite: 0 },
      // Agnes uses chat_template_kwargs.enable_thinking (OpenAI-compat),
      // not reasoning_effort. Override the auto-detected "openai" format.
      ...(m.reasoning ? { compat: { thinkingFormat: "qwen-chat-template" as const } } : {}),
    })),
  });

  // Subscription plan provider — cost = 0.
  pi.registerProvider("agnes-plan", {
    name: "Agnes AI (Token Plan)",
    baseUrl: BASE_URL,
    apiKey: "$AGNES_PLAN_API_KEY",
    api: "openai-completions",
    models: TEXT_MODELS.map((m) => ({
      ...m,
      input: ["text", "image"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(m.reasoning ? { compat: { thinkingFormat: "qwen-chat-template" as const } } : {}),
    })),
  });
}
