/**
 * Regression tests for session-name cleaning limits.
 * Run: node --test packages/pi-session-namer/src/namer.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSessionName } from "./namer.ts";
import type { SessionNamerConfig } from "./types.ts";

async function generatedName(maxLength: number): Promise<string> {
  const rolesApi = {
    async completeWithRole() {
      return { content: [{ type: "text", text: "A descriptive generated session title" }] };
    },
  };
  const config: SessionNamerConfig = { enabled: true, sideAgentRole: "utility", maxLength };
  return generateSessionName(rolesApi as any, "utility", config, "Name this session");
}

test("session namer treats zero length as unlimited", async () => {
  assert.equal(await generatedName(0), "A descriptive generated session title");
});

test("session namer treats negative length as unlimited", async () => {
  assert.equal(await generatedName(-10), "A descriptive generated session title");
});

test("session namer honors small positive hard limits without ellipsis overflow", async () => {
  assert.equal(await generatedName(1), "A");
  assert.equal(await generatedName(2), "A ");
  assert.equal(await generatedName(3), "A d");
  assert.equal(await generatedName(4), "A...");
});
