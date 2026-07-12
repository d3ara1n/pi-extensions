/**
 * Tests for config loading (settings.json parsing + merging).
 *
 * Zero-dependency: runs on node's built-in test runner.
 *   node --test src/config.test.ts
 *
 * loadConfig reads real files (global ~/.pi/agent/settings.json + project
 * .pi/settings.json), but exposes a PI_AGENT_DIR override for the global dir.
 * So we spin up temp dirs, write settings files, and assert end-to-end — this
 * covers the full chain including strict-JSON rejection of comments, file-not-found
 * fallback, parse-failure fallback, and global/project shallow merge, not just
 * the field coercers.
 *
 * Merge semantics (locked in as "A — shallow merge"): a project-level
 * `deniedPaths` / `allowedPaths` REPLACES the global one entirely; it does not
 * merge per-entry. This matches pi's settings convention elsewhere.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./types.ts";

let tmpGlobal = "";
let tmpProject = "";
let savedAgentDir: string | undefined;

function setup(): void {
  tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "ad-global-"));
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "ad-proj-"));
  savedAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = tmpGlobal;
}

function teardown(): void {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
  for (const d of [tmpGlobal, tmpProject]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Write the GLOBAL settings.json (object → JSON, or a raw string for malformed/commented JSON). */
function writeGlobal(objOrRaw: unknown): void {
  const content = typeof objOrRaw === "string" ? objOrRaw : JSON.stringify(objOrRaw);
  fs.writeFileSync(path.join(tmpGlobal, "settings.json"), content);
}

/** Write the PROJECT .pi/settings.json. */
function writeProject(objOrRaw: unknown): void {
  fs.mkdirSync(path.join(tmpProject, ".pi"), { recursive: true });
  const content = typeof objOrRaw === "string" ? objOrRaw : JSON.stringify(objOrRaw);
  fs.writeFileSync(path.join(tmpProject, ".pi", "settings.json"), content);
}

beforeEach(setup);
afterEach(teardown);

// ────────────────────────────────────────────────────────────────────────────
// deniedPaths: grouped-array parsing → flat map
// ────────────────────────────────────────────────────────────────────────────

describe("deniedPaths: grouped format → flat map", () => {
  test("a single group with a reason flattens to one entry", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: [{ paths: ["/old/a"], reason: "moved to /new" }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/old/a": "moved to /new" });
  });

  test("several paths share one reason (the grouping use case)", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: [{ paths: ["/old/a", "/old/b", "/old/c"], reason: "moved to /new" }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, {
      "/old/a": "moved to /new",
      "/old/b": "moved to /new",
      "/old/c": "moved to /new",
    });
  });

  test("omitted reason → null (default message)", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: [{ paths: ["/tmp/legacy"] }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/tmp/legacy": null });
  });

  test("explicit null reason → null", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: [{ paths: ["/x"], reason: null }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/x": null });
  });

  test("mixed groups (some with reason, some without) coexist", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: [
          { paths: ["/a", "/b"], reason: "moved to /new" },
          { paths: ["/cache"] },
          { paths: ["/y"], reason: "another reason" },
        ],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, {
      "/a": "moved to /new",
      "/b": "moved to /new",
      "/cache": null,
      "/y": "another reason",
    });
  });
});

describe("deniedPaths: malformed input is dropped, never crashes", () => {
  test("a non-string reason drops the WHOLE group", () => {
    // A numeric reason is almost certainly a typo; drop the group, keep valid ones.
    writeGlobal({
      accessDenied: {
        deniedPaths: [
          { paths: ["/good"], reason: "ok" },
          { paths: ["/bad"], reason: 123 },
          { paths: ["/also-good"] },
        ],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, {
      "/good": "ok",
      "/also-good": null,
    });
  });

  test("missing `paths` field skips the group", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: [{ reason: "no paths here" }, { paths: ["/kept"], reason: "ok" }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/kept": "ok" });
  });

  test("non-array `paths` skips the group", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: [
          { paths: "/scalar-path", reason: "should-be-array" },
          { paths: ["/kept"], reason: "ok" },
        ],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/kept": "ok" });
  });

  test("non-string path entries are filtered out", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: [{ paths: ["/ok", 42, null, { x: 1 }, "/ok2"], reason: "r" }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/ok": "r", "/ok2": "r" });
  });

  test("empty / whitespace-only path strings are dropped", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: [{ paths: ["", "   ", "/kept"], reason: "r" }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/kept": "r" });
  });

  test("a path appearing in several groups keeps the LAST group's reason", () => {
    // Predictable last-wins; not merged.
    writeGlobal({
      accessDenied: {
        deniedPaths: [
          { paths: ["/dup"], reason: "first" },
          { paths: ["/dup"], reason: "second" },
        ],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/dup": "second" });
  });

  test("empty-string reason is preserved as empty string (PathManager trims later)", () => {
    // config's job is faithful coercion; "" is a valid string reason. The
    // PathManager normalizes "" → undefined (default message) at decision time.
    writeGlobal({
      accessDenied: {
        deniedPaths: [{ paths: ["/x"], reason: "" }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/x": "" });
  });

  test("a non-object group entry is skipped", () => {
    writeGlobal({
      accessDenied: {
        deniedPaths: ["not-an-object", 42, null, { paths: ["/kept"], reason: "ok" }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/kept": "ok" });
  });
});

describe("deniedPaths: wrong top-level type", () => {
  test("object form (old format) is now IGNORED → {}", () => {
    // The format switched from object to grouped array (breaking change).
    // An old-style object is not an array, so it yields {}.
    writeGlobal({
      accessDenied: {
        deniedPaths: { "/old/a": "should-be-ignored" },
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, {});
  });

  test("null / string / number → {}", () => {
    for (const v of [null, "oops", 42]) {
      writeGlobal({ accessDenied: { deniedPaths: v } });
      assert.deepEqual(loadConfig(tmpProject).deniedPaths, {});
    }
  });

  test("absent deniedPaths key → {} (default)", () => {
    writeGlobal({ accessDenied: { mode: "prompt" } });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, {});
  });
});

// ────────────────────────────────────────────────────────────────────────────
// mode, allowedPaths, tools
// ────────────────────────────────────────────────────────────────────────────

describe("mode", () => {
  test("valid modes pass through", () => {
    for (const m of ["prompt", "deny", "allow"] as const) {
      writeGlobal({ accessDenied: { mode: m } });
      assert.equal(loadConfig(tmpProject).mode, m);
    }
  });

  test("invalid mode falls back to default (prompt)", () => {
    for (const m of ["ask", "", "PROMPT", 1, null]) {
      writeGlobal({ accessDenied: { mode: m } });
      assert.equal(loadConfig(tmpProject).mode, DEFAULT_CONFIG.mode);
    }
  });

  test("absent mode → default", () => {
    writeGlobal({ accessDenied: {} });
    assert.equal(loadConfig(tmpProject).mode, DEFAULT_CONFIG.mode);
  });
});

describe("allowedPaths", () => {
  test("string array passes through", () => {
    writeGlobal({
      accessDenied: { allowedPaths: ["~/notes", "/var/log/x"] },
    });
    assert.deepEqual(loadConfig(tmpProject).allowedPaths, ["~/notes", "/var/log/x"]);
  });

  test("non-string entries are filtered", () => {
    writeGlobal({
      accessDenied: { allowedPaths: ["/a", 42, null, "/b", ""] },
    });
    // asStringArray drops non-strings AND empty-trim strings
    assert.deepEqual(loadConfig(tmpProject).allowedPaths, ["/a", "/b"]);
  });

  test("non-array value → default", () => {
    writeGlobal({ accessDenied: { allowedPaths: "/scalar" } });
    assert.deepEqual(loadConfig(tmpProject).allowedPaths, DEFAULT_CONFIG.allowedPaths);
  });
});

describe("tools", () => {
  test("supported tools pass through", () => {
    writeGlobal({ accessDenied: { tools: ["write", "bash"] } });
    assert.deepEqual(loadConfig(tmpProject).tools, ["write", "bash"]);
  });

  test("unknown tools are ignored", () => {
    writeGlobal({ accessDenied: { tools: ["read", "write", "grep", "edit"] } });
    assert.deepEqual(loadConfig(tmpProject).tools, ["write", "edit"]);
  });

  test("empty or invalid tool list falls back to default three", () => {
    writeGlobal({ accessDenied: { tools: ["read", "grep"] } });
    assert.deepEqual(loadConfig(tmpProject).tools, DEFAULT_CONFIG.tools);
  });

  test("non-array → default three", () => {
    writeGlobal({ accessDenied: { tools: "write" } });
    assert.deepEqual(loadConfig(tmpProject).tools, DEFAULT_CONFIG.tools);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// File IO: strict JSON, missing files, parse failures
// ────────────────────────────────────────────────────────────────────────────

describe("settings.json is strict JSON (comments are NOT stripped)", () => {
  // settings.json is standard JSON and does not allow comments. We must NOT
  // pre-strip them — a regex strip would corrupt string literals containing
  // "//" (e.g. URLs like "https://…") into un-closable strings and silently
  // drop the whole config. Malformed JSON instead falls through to the
  // parse-failure fallback (all defaults).
  test("single-line comments → parse fails → all defaults", () => {
    writeGlobal(`{
			"accessDenied": {
				"mode": "deny", // inline comment
				"allowedPaths": ["~/notes"]
			}
		}`);
    const cfg = loadConfig(tmpProject);
    assert.equal(cfg.mode, DEFAULT_CONFIG.mode);
    assert.deepEqual(cfg.allowedPaths, DEFAULT_CONFIG.allowedPaths);
  });

  test("block comments → parse fails → all defaults", () => {
    writeGlobal(`{
			/* global access config */
			"accessDenied": {
				"mode": "allow"
			}
		}`);
    const cfg = loadConfig(tmpProject);
    assert.equal(cfg.mode, DEFAULT_CONFIG.mode);
  });
});

describe("file IO robustness", () => {
  test("missing global settings.json → all defaults", () => {
    // writeGlobal not called → file absent
    const cfg = loadConfig(tmpProject);
    assert.equal(cfg.mode, DEFAULT_CONFIG.mode);
    assert.deepEqual(cfg.allowedPaths, DEFAULT_CONFIG.allowedPaths);
    assert.deepEqual(cfg.deniedPaths, DEFAULT_CONFIG.deniedPaths);
    assert.deepEqual(cfg.tools, DEFAULT_CONFIG.tools);
  });

  test("malformed JSON in global settings → all defaults (no throw)", () => {
    writeGlobal(`{ this is not valid json`);
    const cfg = loadConfig(tmpProject);
    assert.equal(cfg.mode, DEFAULT_CONFIG.mode);
  });

  test("accessDenied absent as a top-level key → defaults", () => {
    writeGlobal({ someOtherKey: 123 });
    const cfg = loadConfig(tmpProject);
    assert.equal(cfg.mode, DEFAULT_CONFIG.mode);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Global + project replacement (project replaces the entire accessDenied block)
// ────────────────────────────────────────────────────────────────────────────

describe("global + project replacement", () => {
  test("project mode overrides global mode", () => {
    writeGlobal({ accessDenied: { mode: "deny" } });
    writeProject({ accessDenied: { mode: "allow" } });
    assert.equal(loadConfig(tmpProject).mode, "allow");
  });

  test("project deniedPaths REPLACES global deniedPaths (not per-entry merge)", () => {
    // Locked-in "A" semantics: shallow merge at the field level.
    writeGlobal({
      accessDenied: {
        deniedPaths: [{ paths: ["/global-only"], reason: "global" }],
      },
    });
    writeProject({
      accessDenied: {
        deniedPaths: [{ paths: ["/project-only"], reason: "project" }],
      },
    });
    const cfg = loadConfig(tmpProject);
    assert.deepEqual(cfg.deniedPaths, { "/project-only": "project" }); // global entry gone
  });

  test("project allowedPaths REPLACES global allowedPaths", () => {
    writeGlobal({ accessDenied: { allowedPaths: ["/global"] } });
    writeProject({ accessDenied: { allowedPaths: ["/project"] } });
    assert.deepEqual(loadConfig(tmpProject).allowedPaths, ["/project"]);
  });

  test("a project accessDenied block replaces the global block; omitted fields use defaults", () => {
    writeGlobal({
      accessDenied: {
        mode: "deny",
        allowedPaths: ["/from-global"],
        deniedPaths: [{ paths: ["/global-denied"], reason: "global" }],
        tools: ["write"],
      },
    });
    writeProject({
      accessDenied: { mode: "allow" },
    });
    const cfg = loadConfig(tmpProject);
    assert.equal(cfg.mode, "allow");
    assert.deepEqual(cfg.allowedPaths, DEFAULT_CONFIG.allowedPaths);
    assert.deepEqual(cfg.deniedPaths, DEFAULT_CONFIG.deniedPaths);
    assert.deepEqual(cfg.tools, DEFAULT_CONFIG.tools);
  });

  test("no project settings → global used", () => {
    writeGlobal({ accessDenied: { mode: "deny", allowedPaths: ["/g"] } });
    // writeProject not called → project file absent
    const cfg = loadConfig(tmpProject);
    assert.equal(cfg.mode, "deny");
    assert.deepEqual(cfg.allowedPaths, ["/g"]);
  });

  test("loadConfig without cwd reads only global settings", () => {
    writeGlobal({ accessDenied: { mode: "deny" } });
    const cfg = loadConfig(); // no project context
    assert.equal(cfg.mode, "deny");
  });
});
