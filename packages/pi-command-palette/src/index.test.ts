/**
 * Regression tests for model reference parsing.
 * Run: node --test packages/pi-command-palette/src/index.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelRef } from "./index.ts";

test("parseModelRef splits provider and model at the first slash", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-sonnet"), {
    provider: "anthropic",
    modelId: "claude-sonnet",
  });
  assert.deepEqual(parseModelRef("openrouter/vendor/model/with/slashes"), {
    provider: "openrouter",
    modelId: "vendor/model/with/slashes",
  });
});

test("parseModelRef preserves empty provider or model segments", () => {
  assert.equal(parseModelRef("model-without-provider"), undefined);
  assert.deepEqual(parseModelRef("/model"), { provider: "", modelId: "model" });
  assert.deepEqual(parseModelRef("provider/"), { provider: "provider", modelId: "" });
});
