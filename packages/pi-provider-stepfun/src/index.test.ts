import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

interface RegisteredProvider {
  baseUrl: string;
  apiKey: string;
  models: {
    id: string;
    contextWindow: number;
    maxTokens: number;
    input: string[];
    compat: { supportsDeveloperRole: boolean; maxTokensField: string };
    thinkingLevelMap?: Record<string, string | null>;
  }[];
}

function registrations(): Record<string, RegisteredProvider> {
  const providers: Record<string, RegisteredProvider> = {};
  register({
    registerProvider(id: string, config: RegisteredProvider) {
      providers[id] = config;
    },
  } as unknown as ExtensionAPI);
  return providers;
}

test("registers the distinct standard and Step Plan channels", () => {
  const providers = registrations();
  assert.deepEqual(Object.keys(providers), ["stepfun", "stepfun-plan"]);
  assert.equal(providers.stepfun.baseUrl, "https://api.stepfun.com/v1");
  assert.equal(providers["stepfun-plan"].baseUrl, "https://api.stepfun.com/step_plan/v1");
  assert.equal(providers.stepfun.apiKey, "$STEP_API_KEY");
  assert.equal(providers["stepfun-plan"].apiKey, "$STEP_PLAN_API_KEY");
});

test("exposes Step 5 on both channels and keeps channel-specific models separate", () => {
  const { stepfun, "stepfun-plan": plan } = registrations();
  for (const provider of [stepfun, plan]) {
    const preview = provider.models.find((model) => model.id === "step-5-preview");
    assert.ok(preview);
    assert.equal(preview.contextWindow, 1_000_000);
    assert.equal(preview.maxTokens, 65_536);
    assert.deepEqual(preview.input, ["text", "image"]);
    assert.equal(preview.compat.supportsDeveloperRole, false);
    assert.equal(preview.compat.maxTokensField, "max_tokens");

    const snapshot = provider.models.find((model) => model.id === "step-3.5-flash-2603");
    assert.ok(snapshot);
    assert.equal(snapshot.thinkingLevelMap?.medium, "low");
  }
  assert.ok(stepfun.models.some((model) => model.id === "step-1o-turbo-vision"));
  assert.ok(!plan.models.some((model) => model.id === "step-1o-turbo-vision"));
  assert.ok(plan.models.some((model) => model.id === "step-router-v1"));
  assert.ok(!stepfun.models.some((model) => model.id === "step-router-v1"));
});
