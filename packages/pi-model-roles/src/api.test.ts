/**
 * Regression tests for model-role fallback resolution.
 * Run: node --test packages/pi-model-roles/src/api.test.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { initModelRolesAPI } from "./api.ts";

const currentModel = { provider: "test", id: "current" };
const registry = {
  getAvailable: () => [currentModel],
  async getApiKeyAndHeaders() {
    return { ok: true, apiKey: "test-key" };
  },
};

function withSettings(
  settings: unknown,
  run: () => void | Promise<void>,
): void | Promise<void> {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-roles-"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = agentDir;
  const cleanup = () => {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(cleanup);
    cleanup();
  } catch (error) {
    cleanup();
    throw error;
  }
}

function withDefaultConfig(run: () => void | Promise<void>): void | Promise<void> {
  return withSettings({}, run);
}

test("resolveRole keeps an unknown requested name while using the default role model", () => {
  withDefaultConfig(() => {
    const api = initModelRolesAPI(registry, currentModel);

    const resolved = api.resolveRole("missing-role");

    assert.equal(resolved.name, "missing-role");
    assert.equal(resolved.config.model, null);
    assert.equal(resolved.model, currentModel);
  });
});

test("unknown roles use the configured fallback model while retaining their name", async () => {
  const fallbackModel = { provider: "test", id: "fallback" };
  const fallbackRegistry = {
    getAvailable: () => [currentModel, fallbackModel],
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "test-key" };
    },
  };

  await withSettings(
    {
      modelRoles: {
        defaultRole: "fallback",
        roles: { fallback: { model: "test/fallback" } },
      },
    },
    async () => {
      const api = initModelRolesAPI(fallbackRegistry, currentModel);

      const resolved = api.resolveRole("missing-role");
      const resolvedAsync = await api.resolveRoleAsync("missing-role");

      assert.equal(resolved.name, "missing-role");
      assert.equal(resolved.model, fallbackModel);
      assert.equal(resolvedAsync.name, "missing-role");
      assert.equal(resolvedAsync.model, fallbackModel);
      assert.equal(resolvedAsync.apiKey, "test-key");
    },
  );
});

test("missing configured default role falls back to the built-in default role", async () => {
  await withSettings(
    { modelRoles: { defaultRole: "not-configured" } },
    async () => {
      const api = initModelRolesAPI(registry, currentModel);

      const resolved = api.resolveRole("missing-role");
      const resolvedAsync = await api.resolveRoleAsync("missing-role");

      assert.equal(resolved.name, "missing-role");
      assert.equal(resolved.config.model, null);
      assert.equal(resolved.model, currentModel);
      assert.equal(resolvedAsync.name, "missing-role");
      assert.equal(resolvedAsync.config.model, null);
      assert.equal(resolvedAsync.model, currentModel);
      assert.equal(resolvedAsync.apiKey, "test-key");
    },
  );
});
