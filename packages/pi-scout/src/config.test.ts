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
  const base = {
    enabled: true,
    sideAgentRole: "utility",
    maxSelectedSkills: 0,
    modules: { skillRouter: false, modelRouter: false, shortCircuit: true },
    shortCircuit: { trivialAck: true, maxAckLength: 12, ackPhrases: [] },
  };
  const disabled = buildScoutSystemPrompt(base, "- skill-a", "- heavy");
  assert.doesNotMatch(disabled, /## Available Skills|## Available Roles|skill-a|heavy/);

  const enabled = buildScoutSystemPrompt(
    { ...base, modules: { ...base.modules, skillRouter: true, modelRouter: true } },
    "- skill-a",
    "- heavy",
  );
  assert.match(enabled, /## Available Skills\n- skill-a/);
  assert.match(enabled, /## Available Roles\n- heavy/);
  assert.match(enabled, /Select at most 0 skills/);
});
