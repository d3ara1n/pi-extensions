import { generateDiffString } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { cropDiff } from "../src/crop.ts";

// pi's diff format: one line per row, " <num> text" / "+<num> text" / "-<num> text".
const context = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ` ${from + index} unchanged`).join("\n");
const added = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `+${from + index} added`).join("\n");
const removed = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `-${from + index} removed`).join("\n");
const lines = (...rows: string[]) => rows.join("\n");

test("crop keeps a changed region that fits the budget", () => {
  const diff = lines(" 1 a", "-2 b", "+2 c", " 3 d");
  assert.equal(cropDiff(diff, DEFAULT_CONFIG), diff);
});

test("crop collapses changed lines beyond the budget into one hint", () => {
  const rows = cropDiff(added(1, 25), DEFAULT_CONFIG).split("\n");

  assert.equal(rows.length, DEFAULT_CONFIG.maxChangedLines + 1);
  assert.equal(rows[0], "+1 added");
  assert.equal(
    rows[DEFAULT_CONFIG.maxChangedLines - 1],
    `+${DEFAULT_CONFIG.maxChangedLines} added`,
  );
  assert.match(rows[DEFAULT_CONFIG.maxChangedLines] ?? "", /^… 15 more changed lines/);
});

test("crop counts removed and added lines against the same budget", () => {
  const rows = cropDiff(lines(removed(1, 8), added(1, 8)), {
    contextLines: 1,
    maxChangedLines: 10,
  }).split("\n");

  assert.equal(rows.length, 11);
  assert.equal(rows[9], "+2 added");
  assert.match(rows[10] ?? "", /^… 6 more changed lines/);
});

test("crop keeps the configured context on each side of a changed region", () => {
  const diff = lines(context(1, 6), "+7 c", context(7, 6));
  assert.deepEqual(cropDiff(diff, { contextLines: 2, maxChangedLines: 10 }).split("\n"), [
    " 5 unchanged",
    " 6 unchanged",
    "+7 c",
    " 7 unchanged",
    " 8 unchanged",
  ]);
});

test("crop drops the context between regions beyond the budget", () => {
  const diff = lines(" 1 a", "+2 b", " 2 c", " 3 d", " 4 e", "+5 f", " 5 g");
  assert.deepEqual(cropDiff(diff, { contextLines: 1, maxChangedLines: 10 }).split("\n"), [
    " 1 a",
    "+2 b",
    " 2 c",
    "… 1 unchanged line",
    " 4 e",
    "+5 f",
    " 5 g",
  ]);
});

test("crop preserves unknown gap sizes in generated diffs", () => {
  const before = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
  const after = [...before];
  after[1] = "changed 2";
  after[98] = "changed 99";
  const { diff } = generateDiffString(before.join("\n"), after.join("\n"));

  const cropped = cropDiff(diff, DEFAULT_CONFIG);
  assert.match(cropped, /3 line 3\n… unchanged lines omitted\n\s+98 line 98/);
  assert.doesNotMatch(cropped, /… \d+ unchanged lines/);
});

test("crop keeps the inner context when the diff starts or ends with several unchanged lines", () => {
  const diff = lines(context(1, 4), "+5 a", context(5, 4));
  assert.deepEqual(cropDiff(diff, { contextLines: 1, maxChangedLines: 10 }).split("\n"), [
    " 4 unchanged",
    "+5 a",
    " 5 unchanged",
  ]);
});

test("crop accepts zero context lines", () => {
  const diff = lines(" 1 a", " 2 b", "-3 c", "+3 c", " 4 d", " 5 e");
  assert.deepEqual(cropDiff(diff, { contextLines: 0, maxChangedLines: 10 }).split("\n"), [
    "-3 c",
    "+3 c",
  ]);
});

test("crop leaves an empty diff empty", () => {
  assert.equal(cropDiff("", DEFAULT_CONFIG), "");
});

test("crop is the identity when the config fits the whole diff", () => {
  const diff = lines(context(1, 40), removed(41, 3), added(41, 3), context(44, 40));
  assert.equal(cropDiff(diff, { contextLines: 40, maxChangedLines: 6 }), diff);
});

test("crop marks the hint line so the renderer paints it as context", () => {
  const hint = cropDiff(added(1, 12), DEFAULT_CONFIG).split("\n").at(-1) ?? "";
  assert.doesNotMatch(hint, /^[+\- ]/);
});

test("config falls back to defaults without any settings file", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "apply-patch-no-such-agent-dir");
  try {
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
    assert.deepEqual(loadConfig(os.tmpdir()), DEFAULT_CONFIG);
  } finally {
    restoreAgentDir(previous);
  }
});

test("config reads the applyPatch block from global settings", () => {
  withSettings({ contextLines: 3, maxChangedLines: 25 }, (cwd) => {
    assert.deepEqual(loadConfig(cwd), { contextLines: 3, maxChangedLines: 25, workspaceOnly: true });
  });
});

test("config replaces the global applyPatch block with a project one", () => {
  withSettings({ contextLines: 3, maxChangedLines: 25 }, (cwd) => {
    writeProjectSettings(cwd, { contextLines: 2 });
    // The project block wins as a whole, so maxChangedLines falls back to the
    // default instead of inheriting the global 25.
    assert.deepEqual(loadConfig(cwd), { contextLines: 2, maxChangedLines: 10, workspaceOnly: true });
  });
});

test("config ignores invalid fields per field", () => {
  withSettings({ contextLines: -1, maxChangedLines: "many" }, (cwd) => {
    assert.deepEqual(loadConfig(cwd), DEFAULT_CONFIG);
  });
  withSettings({ contextLines: 2.9 }, (cwd) => {
    // A budget below the minimum is invalid, not clamped: fall back to default.
    assert.deepEqual(loadConfig(cwd), { contextLines: 2, maxChangedLines: 10, workspaceOnly: true });
  });
});

test("config reads workspaceOnly and defaults it to true", () => {
  withSettings({ workspaceOnly: false }, (cwd) => {
    assert.deepEqual(loadConfig(cwd), { ...DEFAULT_CONFIG, workspaceOnly: false });
  });
  withSettings({ workspaceOnly: "no" }, (cwd) => {
    assert.deepEqual(loadConfig(cwd), DEFAULT_CONFIG);
  });
});

test("config survives an unreadable settings file", () => {
  withSettingsRaw("{ not json", (cwd) => {
    assert.deepEqual(loadConfig(cwd), DEFAULT_CONFIG);
  });
});

function restoreAgentDir(previous: string | undefined): void {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
}

/** Point the global settings location at a temp dir holding `applyPatch`. */
function withSettings(applyPatch: unknown, run: (cwd: string) => void): void {
  withSettingsRaw(JSON.stringify({ applyPatch }), run);
}

function withSettingsRaw(settingsJson: string, run: (cwd: string) => void): void {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-config-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-project-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    fs.writeFileSync(path.join(agentDir, "settings.json"), settingsJson);
    run(cwd);
  } finally {
    restoreAgentDir(previous);
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function writeProjectSettings(cwd: string, applyPatch: unknown): void {
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ applyPatch }));
}
