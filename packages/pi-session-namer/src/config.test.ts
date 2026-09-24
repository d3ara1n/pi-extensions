import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadNamerConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./types.ts";

test("periodic naming is disabled by default and can be enabled or disabled in project settings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-session-namer-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = cwd;
    assert.equal(DEFAULT_CONFIG.periodicRename, false);
    const settings = join(cwd, ".pi", "settings.json");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(settings, JSON.stringify({ sessionNamer: { periodicRename: true } }));
    assert.equal(loadNamerConfig(cwd).periodicRename, true);

    writeFileSync(settings, JSON.stringify({ sessionNamer: { periodicRename: false } }));
    assert.equal(loadNamerConfig(cwd).periodicRename, false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  }
});
