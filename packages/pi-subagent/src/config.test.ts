/**
 * Configuration loading regression tests.
 *
 * Uses isolated global/project settings roots via PI_AGENT_DIR.
 *   node --test packages/pi-subagent/src/config.test.ts
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSubagentConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./types.ts";

const originalAgentDir = process.env.PI_AGENT_DIR;
const tempRoots: string[] = [];

function makeRoot(): { agentDir: string; projectDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-config-test-"));
  tempRoots.push(root);
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  process.env.PI_AGENT_DIR = agentDir;
  return { agentDir, projectDir };
}

function writeSettings(dir: string, settings: unknown): void {
  writeSettingsText(dir, JSON.stringify(settings));
}

function writeSettingsText(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), content);
}

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = originalAgentDir;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("loadSubagentConfig", () => {
  test("preserves zero limits and clamps negative numeric limits to unlimited", () => {
    const { agentDir } = makeRoot();
    writeSettings(agentDir, {
      subagent: {
        timeout: 0,
        maxConcurrency: -1,
        maxDepth: -2,
        maxTurns: 0,
        maxCost: -0.5,
      },
    });

    const config = loadSubagentConfig();
    assert.equal(config.timeout, 0);
    assert.equal(config.maxConcurrency, 0);
    assert.equal(config.maxDepth, 0);
    assert.equal(config.maxTurns, 0);
    assert.equal(config.maxCost, 0);
  });

  test("uses defaults for non-finite or non-numeric numeric limits", () => {
    const { agentDir } = makeRoot();
    // JSON.parse accepts numeric overflow as Infinity, even though JSON.stringify
    // would serialize it as null. Exercise both non-finite and wrong-type inputs.
    writeSettingsText(
      agentDir,
      '{"subagent":{"timeout":1e999,"maxConcurrency":-1e999,"maxDepth":{},"maxTurns":false,"maxCost":"NaN"}}',
    );

    const config = loadSubagentConfig();
    assert.equal(config.timeout, DEFAULT_CONFIG.timeout);
    assert.equal(config.maxConcurrency, DEFAULT_CONFIG.maxConcurrency);
    assert.equal(config.maxDepth, DEFAULT_CONFIG.maxDepth);
    assert.equal(config.maxTurns, DEFAULT_CONFIG.maxTurns);
    assert.equal(config.maxCost, DEFAULT_CONFIG.maxCost);
  });

  test("floors finite fractional count limits", () => {
    const { agentDir } = makeRoot();
    writeSettings(agentDir, {
      subagent: { maxConcurrency: 2.9, maxDepth: 3.1, maxTurns: 4.8 },
    });

    const config = loadSubagentConfig();
    assert.equal(config.maxConcurrency, 2);
    assert.equal(config.maxDepth, 3);
    assert.equal(config.maxTurns, 4);
  });

  test("project subagent block replaces global wholesale and defaults omitted fields", () => {
    const { agentDir, projectDir } = makeRoot();
    writeSettings(agentDir, {
      subagent: {
        timeout: 999,
        maxConcurrency: 8,
        maxDepth: 7,
        maxTurns: 6,
        maxCost: 5,
        history: { enabled: false },
        summary: { enabled: false, role: "global-summary" },
        agentOverrides: { global: { disabled: true } },
      },
    });
    writeSettings(path.join(projectDir, ".pi"), {
      subagent: { timeout: 12, summary: { role: "project-summary" } },
    });

    const config = loadSubagentConfig(projectDir);
    assert.equal(config.timeout, 12);
    assert.equal(config.maxConcurrency, DEFAULT_CONFIG.maxConcurrency);
    assert.equal(config.maxDepth, DEFAULT_CONFIG.maxDepth);
    assert.equal(config.maxTurns, DEFAULT_CONFIG.maxTurns);
    assert.equal(config.maxCost, DEFAULT_CONFIG.maxCost);
    assert.deepEqual(config.history, DEFAULT_CONFIG.history);
    assert.deepEqual(config.summary, { enabled: DEFAULT_CONFIG.summary.enabled, role: "project-summary" });
    assert.deepEqual(config.agentOverrides, {});
  });
});
