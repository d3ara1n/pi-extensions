/**
 * Tests for the scout decision engine (pure orchestration).
 * Run: node --test packages/pi-scout/src/engine.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDecision } from "./engine.ts";
import type { ScoutConfig, ScoutContext, ScoutDecision } from "./types.ts";

function makeCtx(config: ScoutConfig): ScoutContext {
  return {
    config,
    pi: {} as any,
    rolesApi: { getVisibleRoles: () => ({ default: {} }) } as any,
    skillEntries: [{ name: "skill-a", description: "d", filePath: "/p" }],
    currentRole: "default",
    systemPrompt: "",
    theme: { fg: (_c: string, s: string) => s } as any,
  };
}

const base: ScoutConfig = {
  enabled: true,
  sideAgentRole: "utility",
  maxSelectedSkills: 5,
  modules: { skillRouter: true, modelRouter: false, shortCircuit: true },
  shortCircuit: { trivialAck: true, maxAckLength: 12, ackPhrases: [] },
};

test("normalizeDecision preserves errorDetail so notify can fire", () => {
  // Regression: the decision must be spread, not hand-reconstructed field by
  // field, or errorDetail (the long cause for notify) gets silently dropped.
  const decision: ScoutDecision = {
    fields: { skills: [], role: null },
    reasoning: "upstream error",
    errorDetail: "服务内部错误（上游原因：all nodes failed to stream）",
    source: "error",
  };

  const out = normalizeDecision(decision, makeCtx(base));

  assert.equal(out.source, "error");
  assert.equal(out.reasoning, "upstream error");
  assert.equal(
    out.errorDetail,
    "服务内部错误（上游原因：all nodes failed to stream）",
  );
});

test("normalizeDecision zeros disabled-module fields", () => {
  // model-router is off in `base`; even if a role leaked in, it is zeroed.
  const decision: ScoutDecision = {
    fields: { skills: ["skill-a"], role: "heavy" },
    reasoning: "x",
    source: "side-agent",
  };

  const out = normalizeDecision(decision, makeCtx(base));

  assert.deepEqual(out.fields, { skills: ["skill-a"], role: null });
  assert.equal(out.source, "side-agent");
});

test("normalizeDecision flags a validate error and carries the cause through", () => {
  // model-router on, side agent picked a hidden role → validate errors.
  const cfg: ScoutConfig = {
    ...base,
    modules: { skillRouter: true, modelRouter: true, shortCircuit: true },
  };
  const decision: ScoutDecision = {
    fields: { skills: [], role: "nonexistent" },
    reasoning: "ok",
    errorDetail: "carried",
    source: "side-agent",
  };

  const out = normalizeDecision(decision, makeCtx(cfg));

  assert.equal(out.source, "error");
  assert.equal(out.fields.role, null);
  // errorDetail from the original decision survives the rebuild.
  assert.equal(out.errorDetail, "carried");
});
