/**
 * Configuration loading regression tests.
 *
 * Uses isolated global/project settings roots via PI_CODING_AGENT_DIR.
 *   node --test packages/pi-subagent/src/config.test.ts
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSubagentConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./types.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoots: string[] = [];

function makeRoot(): { agentDir: string; projectDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-config-test-"));
  tempRoots.push(root);
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
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
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("loadSubagentConfig", () => {
  test("uses the inheritance default and accepts only positive finite integer maxChars", () => {
    const { agentDir } = makeRoot();
    writeSettings(agentDir, { subagent: { inheritance: { maxChars: 12 } } });
    assert.equal(loadSubagentConfig().inheritance.maxChars, 12);

    for (const maxChars of [0, -1, 0.5, 12.9, "500", false, null]) {
      writeSettings(agentDir, { subagent: { inheritance: { maxChars } } });
      assert.equal(loadSubagentConfig().inheritance.maxChars, DEFAULT_CONFIG.inheritance.maxChars);
    }
    writeSettingsText(agentDir, '{"subagent":{"inheritance":{"maxChars":1e999}}}');
    assert.equal(loadSubagentConfig().inheritance.maxChars, DEFAULT_CONFIG.inheritance.maxChars);
  });

  test("preserves zero limits and clamps negative numeric limits to unlimited", () => {
    const { agentDir } = makeRoot();
    writeSettings(agentDir, {
      subagent: {
        maxConcurrency: -1,
        maxDepth: -2,
        maxTurns: 0,
        maxCost: -0.5,
      },
    });

    const config = loadSubagentConfig();
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
      '{"subagent":{"maxConcurrency":-1e999,"maxDepth":{},"maxTurns":false,"maxCost":"NaN"}}',
    );

    const config = loadSubagentConfig();
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

  test("project subagent block merges into global at the field level (omitted fields inherit global)", () => {
    const { agentDir, projectDir } = makeRoot();
    writeSettings(agentDir, {
      subagent: {
        maxConcurrency: 8,
        maxDepth: 7,
        maxTurns: 6,
        maxCost: 5,
        history: { enabled: false },
        summary: { enabled: false, role: "global-summary" },
        inheritance: { maxChars: 1234 },
        agentOverrides: { global: { disabled: true }, shared: { maxTurns: 10 } },
      },
    });
    writeSettings(path.join(projectDir, ".pi"), {
      subagent: {
        summary: { role: "project-summary" },
        agentOverrides: { shared: { timeout: 1500 }, projectOnly: { disabled: true } },
      },
    });

    const config = loadSubagentConfig(projectDir);
    // Top-level scalars: project omits them, so they inherit the global values.
    assert.equal(config.maxConcurrency, 8);
    assert.equal(config.maxDepth, 7);
    assert.equal(config.maxTurns, 6);
    assert.equal(config.maxCost, 5);
    // Nested blocks merge field by field: project sets summary.role, the rest
    // inherits from global (not DEFAULT).
    assert.deepEqual(config.history, { enabled: false });
    assert.deepEqual(config.summary, { enabled: false, role: "project-summary" });
    assert.deepEqual(config.inheritance, { maxChars: 1234 });
    // agentOverrides merges per role: the shared role's fields are merged
    // (global maxTurns:10 + project timeout:1500), global-only and project-only
    // roles both survive.
    assert.deepEqual(config.agentOverrides, {
      global: { disabled: true },
      shared: { maxTurns: 10, timeout: 1500 },
      projectOnly: { disabled: true },
    });
  });

  test("project overrides the same fields as global and falls back to DEFAULT for the rest", () => {
    const { agentDir, projectDir } = makeRoot();
    writeSettings(agentDir, {
      subagent: { maxConcurrency: 8, summary: { enabled: false, role: "global-summary" } },
    });
    writeSettings(path.join(projectDir, ".pi"), {
      subagent: { maxConcurrency: 2, summary: { role: "project-summary" } },
    });

    const config = loadSubagentConfig(projectDir);
    // Project wins where it overrides.
    assert.equal(config.maxConcurrency, 2);
    assert.equal(config.summary.role, "project-summary");
    // Global still supplies the project-omitted summary.enabled.
    assert.equal(config.summary.enabled, false);
    // Neither sets maxDepth/maxTurns/maxCost/history/inheritance, so DEFAULT.
    assert.equal(config.maxDepth, DEFAULT_CONFIG.maxDepth);
    assert.equal(config.maxTurns, DEFAULT_CONFIG.maxTurns);
    assert.equal(config.maxCost, DEFAULT_CONFIG.maxCost);
    assert.deepEqual(config.history, DEFAULT_CONFIG.history);
    assert.deepEqual(config.inheritance, DEFAULT_CONFIG.inheritance);
  });
});
