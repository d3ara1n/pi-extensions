/**
 * Regression tests for scout configuration and pure routing helpers.
 * Run: node --test packages/pi-scout/src/config.test.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadScoutConfig } from "./config.ts";
import { buildScoutSystemPrompt } from "./scout-prompt.ts";
import type { ScoutConfig, ScoutContext } from "./types.ts";

/** Minimal ScoutContext for prompt-only tests. */
function makeCtx(config: ScoutConfig): ScoutContext {
  return {
    config,
    pi: {} as any,
    rolesApi: { getVisibleRoles: () => ({ heavy: { model: "m/h" } }) } as any,
    skillEntries: [{ name: "skill-a", description: "desc", filePath: "/p" }],
    currentRole: "default",
    systemPrompt: "",
    theme: { fg: (_c: string, s: string) => s } as any,
  };
}

function withSettings(
  globalSettings: object,
  projectSettings: object | undefined,
  run: (cwd: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scout-config-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(globalSettings));
  if (projectSettings) {
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(projectSettings));
  }

  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = agentDir;
  try {
    run(cwd);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("scout config clamps non-positive maxSelectedSkills to zero", () => {
  withSettings({ scout: { maxSelectedSkills: -4 } }, undefined, (cwd) => {
    assert.equal(loadScoutConfig(cwd).maxSelectedSkills, 0);
  });

  withSettings({ scout: { maxSelectedSkills: 2 } }, { scout: { maxSelectedSkills: 0 } }, (cwd) => {
    assert.equal(loadScoutConfig(cwd).maxSelectedSkills, 0);
  });
});

test("project scout block replaces global fields before defaults fill gaps", () => {
  withSettings(
    { scout: { sideAgentRole: "global-role", modules: { modelRouter: true } } },
    { scout: { enabled: false } },
    (cwd) => {
      const config = loadScoutConfig(cwd);
      assert.equal(config.enabled, false);
      assert.equal(config.sideAgentRole, "utility");
      assert.equal(config.modules.modelRouter, false);
    },
  );
});

test("scout prompt exposes skills and roles only for their enabled modules", () => {
  const base: ScoutConfig = {
    enabled: true,
    sideAgentRole: "utility",
    maxSelectedSkills: 0,
    modules: { skillRouter: false, modelRouter: false, shortCircuit: true },
    shortCircuit: { trivialAck: true, maxAckLength: 12, ackPhrases: [] },
  };
  const disabled = buildScoutSystemPrompt(makeCtx(base));
  assert.doesNotMatch(disabled, /## Available Skills|## Available Roles|skill-a|heavy/);

  const enabled = buildScoutSystemPrompt(
    makeCtx({ ...base, modules: { ...base.modules, skillRouter: true, modelRouter: true } }),
  );
  assert.match(enabled, /## Available Skills\n- skill-a/);
  assert.match(enabled, /## Available Roles\n- heavy/);
  assert.match(enabled, /Select at most 0 skills/);
});

test("model-router off leaks no role concept into the prompt", () => {
  const base: ScoutConfig = {
    enabled: true,
    sideAgentRole: "utility",
    maxSelectedSkills: 5,
    modules: { skillRouter: true, modelRouter: false, shortCircuit: true },
    shortCircuit: { trivialAck: true, maxAckLength: 12, ackPhrases: [] },
  };
  const prompt = buildScoutSystemPrompt(makeCtx(base));
  // With model-router off, no role concept should appear anywhere — no format
  // line, no rule, no Available Roles, no "model role"/"Current role:".
  assert.doesNotMatch(prompt, /role/i);
  // Skills are still routed.
  assert.match(prompt, /## Available Skills/);
  assert.match(prompt, /decide which skills to use/);
});
