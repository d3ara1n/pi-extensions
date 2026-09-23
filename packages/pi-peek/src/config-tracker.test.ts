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
import { getMainAgentStatus, onToolEnd, onToolStart, onTurnEnd, onTurnStart } from "./tracker.ts";
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
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = globalDir;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  fs.rmSync(globalDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("loadPeekConfig floors valid numeric values and falls back for invalid values", () => {
  writeJson(path.join(globalDir, "settings.json"), {
    peek: {
      timeoutMs: 70_000.9,
      role: "  reviewer  ",
    },
  });

  assert.deepEqual(loadPeekConfig(projectDir), {
    ...DEFAULT_PEEK_CONFIG,
    timeoutMs: 70_000,
    role: "reviewer",
  });
});

test("loadPeekConfig lets a project block replace global fields wholesale", () => {
  writeJson(path.join(globalDir, "settings.json"), {
    peek: { timeoutMs: 200_000, role: "global" },
  });
  writeJson(path.join(projectDir, ".pi", "settings.json"), {
    peek: { timeoutMs: 30_000.2 },
  });

  assert.deepEqual(loadPeekConfig(projectDir), {
    ...DEFAULT_PEEK_CONFIG,
    timeoutMs: 30_000,
  });
});

test("config bounds deadlines and rounds while accepting an explicit output budget", () => {
  writeJson(path.join(globalDir, "settings.json"), {
    peek: {
      recentTurns: 1,
      referenceChars: 10,
      maxOutputTokens: 2048,
      maxRounds: 100,
      timeoutMs: 3_000_000_000,
    },
  });
  assert.deepEqual(loadPeekConfig(projectDir), {
    role: "utility",
    timeoutMs: 2_147_483_647,
    maxRounds: 20,
    maxOutputTokens: 2048,
  });
  writeJson(path.join(globalDir, "settings.json"), {
    peek: { timeoutMs: 0.5, maxRounds: -1, maxOutputTokens: "8192" },
  });
  assert.deepEqual(loadPeekConfig(projectDir), DEFAULT_PEEK_CONFIG);
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
