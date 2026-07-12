/**
 * Regression tests for peek configuration coercion and local tracker snapshots.
 * Run: node --test packages/pi-peek/src/config-tracker.test.ts
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadPeekConfig } from "./config.ts";
import {
  getMainAgentStatus,
  onToolEnd,
  onToolStart,
  onTurnEnd,
  onTurnStart,
} from "./tracker.ts";
import { DEFAULT_PEEK_CONFIG } from "./types.ts";

let globalDir = "";
let projectDir = "";
let savedAgentDir: string | undefined;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

beforeEach(() => {
  globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-global-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-project-"));
  savedAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = globalDir;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
  fs.rmSync(globalDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("loadPeekConfig floors valid numeric values and falls back for invalid values", () => {
  writeJson(path.join(globalDir, "settings.json"), {
    peek: {
      recentTurns: 7.9,
      maxChars: Infinity,
      toolResultLimit: -1,
      role: "  reviewer  ",
    },
  });

  assert.deepEqual(loadPeekConfig(projectDir), {
    recentTurns: 7,
    maxChars: DEFAULT_PEEK_CONFIG.maxChars,
    toolResultLimit: DEFAULT_PEEK_CONFIG.toolResultLimit,
    role: "  reviewer  ",
  });
});

test("loadPeekConfig lets a project block replace global fields wholesale", () => {
  writeJson(path.join(globalDir, "settings.json"), {
    peek: { recentTurns: 20, maxChars: 10_000, toolResultLimit: 1_000, role: "global" },
  });
  writeJson(path.join(projectDir, ".pi", "settings.json"), {
    peek: { recentTurns: 3.2 },
  });

  assert.deepEqual(loadPeekConfig(projectDir), {
    recentTurns: 3,
    maxChars: DEFAULT_PEEK_CONFIG.maxChars,
    toolResultLimit: DEFAULT_PEEK_CONFIG.toolResultLimit,
    role: DEFAULT_PEEK_CONFIG.role,
  });
});

test("tracker reports tool activity and ignores an unrelated tool completion", () => {
  onTurnStart(12);
  onToolStart("bash", { command: "npm test\nprintf ignored" });
  const active = getMainAgentStatus();
  assert.equal(active.activity, "bash: npm test");
  assert.equal(active.toolName, "bash");
  assert.equal(active.toolIndex, 1);
  assert.equal(active.turn, 12);

  onToolEnd("read");
  assert.equal(getMainAgentStatus().activity, "bash: npm test");
  assert.equal(getMainAgentStatus().toolName, "bash");

  onToolEnd("bash");
  assert.equal(getMainAgentStatus().activity, "thinking");
  assert.equal(getMainAgentStatus().toolName, undefined);

  onTurnEnd(12);
  const idle = getMainAgentStatus();
  assert.equal(idle.activity, "idle");
  assert.equal(idle.turn, 12);
  assert.match(idle.lastUpdated, /^\d{4}-\d{2}-\d{2}T/);
});
