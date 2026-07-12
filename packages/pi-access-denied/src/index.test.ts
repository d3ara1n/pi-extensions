/**
 * Regression tests for authorization decisions through the extension hook.
 *
 * Run with: node --test src/index.test.ts
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import accessDenied from "./index.ts";
import type { AuthResult } from "./types.ts";

type Handler = (...args: any[]) => any;

let project = "";
let shutdown: (() => Promise<void>) | undefined;

afterEach(() => {
  return (async () => {
    await shutdown?.();
    shutdown = undefined;
    if (project) fs.rmSync(project, { recursive: true, force: true });
    project = "";
  })();
});

test("mixed always-allow and deny persists the grant while blocking the call", async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "ad-index-test-"));
  fs.mkdirSync(path.join(project, ".pi"));
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({ accessDenied: { mode: "prompt" } }),
  );

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  accessDenied({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command);
    },
  } as any);

  const start = handlers.get("session_start");
  const toolCall = handlers.get("tool_call");
  const status = commands.get("access-denied:status");
  const stop = handlers.get("session_shutdown");
  assert.ok(start);
  assert.ok(toolCall);
  assert.ok(status);
  assert.ok(stop);
  shutdown = () => stop();

  const alwaysAllowed = "/mixed-authorization-allow";
  const denied = "/mixed-authorization-deny";
  const decision: AuthResult = {
    cancelled: false,
    choices: new Map([
      [alwaysAllowed, "always-allow"],
      [denied, "deny"],
    ]),
    reason: "not this call",
  };
  let prompts = 0;
  const notices: string[] = [];
  const ctx = {
    cwd: project,
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      custom: async () => {
        prompts++;
        return decision;
      },
      notify: (message: string) => notices.push(message),
    },
  };

  await start({}, ctx);
  const blocked = await toolCall(
    {
      type: "tool_call",
      toolCallId: "mixed",
      toolName: "bash",
      input: { command: `cat ${alwaysAllowed} ${denied}` },
    },
    ctx,
  );

  assert.deepEqual(blocked, {
    block: true,
    reason: 'Blocked by access-denied (user note: "not this call")',
  });

  // The prior mixed decision installed the session grant, so this call no
  // longer prompts and is allowed through the gate.
  const allowed = await toolCall(
    { type: "tool_call", toolCallId: "remembered", toolName: "write", input: { path: alwaysAllowed } },
    ctx,
  );
  assert.equal(allowed, undefined);
  assert.equal(prompts, 1);

  await status.handler([], ctx);
  assert.ok(notices.at(-1)?.includes(`  • ${alwaysAllowed}   (session)`));
});
