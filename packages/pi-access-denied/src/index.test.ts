/**
 * Regression tests for authorization decisions through the extension hook.
 *
 * Run with: node --test src/index.test.ts
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { paths as path } from "./paths.ts";

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
  project = fs.mkdtempSync(path.join(path.temp, "ad-index-test-"));
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
    mode: "tui",
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
    {
      type: "tool_call",
      toolCallId: "remembered",
      toolName: "write",
      input: { path: alwaysAllowed },
    },
    ctx,
  );
  assert.equal(allowed, undefined);
  assert.equal(prompts, 1);

  await status.handler([], ctx);
  assert.ok(notices.at(-1)?.includes(`  • ${alwaysAllowed}   (session)`));
});

test("prompt mode outside TUI falls back to select() dialogs — allow passes through", async () => {
  project = fs.mkdtempSync(path.join(path.temp, "ad-rpc-test-"));
  fs.mkdirSync(path.join(project, ".pi"));
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({ accessDenied: { mode: "prompt" } }),
  );

  const handlers = new Map<string, Handler>();
  accessDenied({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as any);

  const start = handlers.get("session_start");
  const toolCall = handlers.get("tool_call");
  const stop = handlers.get("session_shutdown");
  assert.ok(start);
  assert.ok(toolCall);
  assert.ok(stop);
  shutdown = () => stop();

  let customCalled = false;
  const selections: string[][] = [];
  const titles: string[] = [];
  const ctx = {
    cwd: project,
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      custom: async () => {
        customCalled = true;
        throw new Error("custom should not be called outside TUI");
      },
      // ACP hosts answer extension_ui_request via this path.
      select: async (title: string, options: string[]) => {
        selections.push(options);
        titles.push(title);
        return titles.length === 1 ? "Allow" : "Always allow";
      },
    },
  };

  await start({}, ctx);
  const result = await toolCall(
    {
      type: "tool_call",
      toolCallId: "rpc-outside",
      toolName: "bash",
      input: { command: "cat /etc/passwd" },
    },
    ctx,
  );

  assert.equal(customCalled, false);
  assert.equal(result, undefined); // allowed through after user picked Allow
  assert.deepEqual(selections, [["Allow", "Always allow", "Deny", "Always deny"]]);
  assert.ok(titles[0].includes(path.normalize("/etc/passwd")));
  assert.ok(!titles[0].includes("[estimate]"));

  const estimated = await toolCall(
    {
      type: "tool_call",
      toolCallId: "rpc-estimate",
      toolName: "bash",
      input: { command: 'if check; then f=/etc/shadow; else f=src/file; fi; cat "$f"' },
    },
    ctx,
  );
  assert.equal(estimated, undefined);
  assert.ok(titles[1].includes(path.normalize("/etc/shadow")));
  assert.ok(titles[1].includes("[estimate]"));

  // The label is display metadata; session rules still use the original path.
  const remembered = await toolCall(
    {
      type: "tool_call",
      toolCallId: "rpc-estimate-remembered",
      toolName: "write",
      input: { path: "/etc/shadow" },
    },
    ctx,
  );
  assert.equal(remembered, undefined);
  assert.equal(titles.length, 2);
});

test("prompt mode outside TUI: dismissing the dialog soft-denies", async () => {
  project = fs.mkdtempSync(path.join(path.temp, "ad-rpc-test-"));
  fs.mkdirSync(path.join(project, ".pi"));
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({ accessDenied: { mode: "prompt" } }),
  );

  const handlers = new Map<string, Handler>();
  accessDenied({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as any);

  const start = handlers.get("session_start");
  const toolCall = handlers.get("tool_call");
  const stop = handlers.get("session_shutdown");
  assert.ok(start);
  assert.ok(toolCall);
  assert.ok(stop);
  shutdown = () => stop();

  const ctx = {
    cwd: project,
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      // No host answers (or user cancels): select resolves undefined.
      select: async () => undefined,
    },
  };

  await start({}, ctx);
  const result = await toolCall(
    {
      type: "tool_call",
      toolCallId: "rpc-dismissed",
      toolName: "bash",
      input: { command: "cat /etc/passwd" },
    },
    ctx,
  );

  assert.deepEqual(result, { block: true, reason: "Authorization dismissed" });
});

test("prompt mode outside TUI: always-deny via dialog is remembered for the session", async () => {
  project = fs.mkdtempSync(path.join(path.temp, "ad-rpc-test-"));
  fs.mkdirSync(path.join(project, ".pi"));
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({ accessDenied: { mode: "prompt" } }),
  );

  const handlers = new Map<string, Handler>();
  accessDenied({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as any);

  const start = handlers.get("session_start");
  const toolCall = handlers.get("tool_call");
  const stop = handlers.get("session_shutdown");
  assert.ok(start);
  assert.ok(toolCall);
  assert.ok(stop);
  shutdown = () => stop();

  let calls = 0;
  const ctx = {
    cwd: project,
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      select: async () => {
        calls++;
        return "Always deny";
      },
    },
  };

  await start({}, ctx);
  const first = await toolCall(
    {
      type: "tool_call",
      toolCallId: "rpc-deny",
      toolName: "bash",
      input: { command: "cat /etc/passwd" },
    },
    ctx,
  );
  assert.ok(first && typeof first === "object" && "block" in first);
  assert.ok((first as any).reason.includes("Blocked by access-denied"));

  // Second call hits the remembered session deny without prompting again.
  const second = await toolCall(
    {
      type: "tool_call",
      toolCallId: "rpc-deny-2",
      toolName: "bash",
      input: { command: "cat /etc/passwd" },
    },
    ctx,
  );
  assert.ok(second && typeof second === "object" && "block" in second);
  assert.equal(calls, 1);
});

test("deny mode blocks apply_patch paths outside the project", async () => {
  project = fs.mkdtempSync(path.join(path.temp, "ad-patch-test-"));
  fs.mkdirSync(path.join(project, ".pi"));
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({ accessDenied: { mode: "deny" } }),
  );

  const handlers = new Map<string, Handler>();
  accessDenied({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as any);

  const start = handlers.get("session_start");
  const toolCall = handlers.get("tool_call");
  const stop = handlers.get("session_shutdown");
  assert.ok(start);
  assert.ok(toolCall);
  assert.ok(stop);
  shutdown = () => stop();

  const ctx = {
    cwd: project,
    mode: "rpc",
    hasUI: false,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
    },
  };
  await start({}, ctx);

  const inside = await toolCall(
    {
      type: "tool_call",
      toolCallId: "patch-inside",
      toolName: "apply_patch",
      input: { input: "*** Begin Patch\n*** Add File: inside.txt\n+x\n*** End Patch" },
    },
    ctx,
  );
  assert.equal(inside, undefined);

  const outside = path.join(path.root(project), "outside-patch.txt");
  const blocked = await toolCall(
    {
      type: "tool_call",
      toolCallId: "patch-outside",
      toolName: "apply_patch",
      input: { input: `*** Begin Patch\n*** Add File: ${outside}\n+x\n*** End Patch` },
    },
    ctx,
  );
  assert.ok(blocked && typeof blocked === "object" && "block" in blocked);
  assert.match((blocked as any).reason, /Blocked by access-denied/);
  assert.match((blocked as any).reason, /outside-patch\.txt/);
});

test("allow mode still enforces explicit denies for detected patch paths", async () => {
  project = fs.mkdtempSync(path.join(path.temp, "ad-patch-parse-"));
  const denied = path.join(path.root(project), "blocked-patch.txt");
  fs.mkdirSync(path.join(project, ".pi"));
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({
      accessDenied: { mode: "allow", deniedPaths: [{ paths: [denied], reason: "use another file" }] },
    }),
  );

  const handlers = new Map<string, Handler>();
  accessDenied({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as any);

  const start = handlers.get("session_start");
  const toolCall = handlers.get("tool_call");
  const stop = handlers.get("session_shutdown");
  assert.ok(start);
  assert.ok(toolCall);
  assert.ok(stop);
  shutdown = () => stop();

  const ctx = {
    cwd: project,
    mode: "rpc",
    hasUI: false,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
    },
  };
  await start({}, ctx);

  const blocked = await toolCall(
    {
      type: "tool_call",
      toolCallId: "patch-parse",
      toolName: "apply_patch",
      input: {
        input: `<<'EOF'\n*** Begin Patch\n*** Unknown: x\n*** Add File: ${denied}\n+x\n*** End Patch\nEOF`,
      },
    },
    ctx,
  );
  assert.ok(blocked && typeof blocked === "object" && "block" in blocked);
  assert.match((blocked as any).reason, /use another file/);
});
