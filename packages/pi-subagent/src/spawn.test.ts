/**
 * Unit tests for spawn-side pure logic.
 *
 *   node --test packages/pi-subagent/src/spawn.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyChildSettlement, buildChildArgs, composeInitialMessage } from "./spawn.ts";

test("aborted settlement replaces a stale provider failure from the last assistant attempt", () => {
  const result = { stopReason: "error", errorMessage: "429 during retry" };
  applyChildSettlement(result, true, false);
  assert.equal(result.stopReason, "aborted");
  assert.doesNotMatch(result.errorMessage, /429/);
});

test("settlement preserves parent-requested stops and non-aborted failures", () => {
  for (const stopReason of ["timeout", "budget_exceeded", "cancelled"]) {
    const result = { stopReason, errorMessage: "original cause" };
    applyChildSettlement(result, true, true);
    assert.deepEqual(result, { stopReason, errorMessage: "original cause" });
  }
  const failure = { stopReason: "error", errorMessage: "429" };
  applyChildSettlement(failure, false, false);
  assert.deepEqual(failure, { stopReason: "error", errorMessage: "429" });
});

describe("composeInitialMessage", () => {
  test("wraps reference files in <file> blocks ahead of context and task", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-test-"));
    try {
      const fileA = path.join(dir, "a.md");
      fs.writeFileSync(fileA, "alpha content");
      const message = await composeInitialMessage([fileA], undefined, "some ctx", "do the thing");
      assert.equal(
        message,
        `<file name="${fileA}">\nalpha content\n</file>\n\n<context>\nsome ctx\n</context>\n\n<task>\ndo the thing\n</task>`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("omits absent channels and preserves relative block order", async () => {
    const message = await composeInitialMessage(undefined, undefined, undefined, "only a task");
    assert.equal(message, "<task>\nonly a task\n</task>");
    const ctxOnly = await composeInitialMessage(undefined, undefined, "ctx body", "");
    assert.equal(ctxOnly, "<context>\nctx body\n</context>");
  });

  test("unreadable files degrade to a placeholder instead of failing the run", async () => {
    const missing = path.join(os.tmpdir(), "pi-sub-test-does-not-exist.md");
    const message = await composeInitialMessage([missing], undefined, undefined, "t");
    assert.match(message, /^\[?<file name="/);
    assert.match(message, /failed to read file/);
    assert.match(message, /\n\n<task>\nt\n<\/task>$/);
  });

  test("blank (whitespace-only) context is dropped", async () => {
    const message = await composeInitialMessage(undefined, undefined, "   \n\t", "t");
    assert.equal(message, "<task>\nt\n</task>");
  });

  test("puts inherited conversation after files and before context/task", async () => {
    const message = await composeInitialMessage(
      ["missing.txt"],
      "parent text",
      "explicit ctx",
      "delta task",
    );
    assert.ok(
      message.indexOf('<file name="missing.txt">') < message.indexOf("<inherited_conversation>"),
    );
    assert.ok(message.indexOf("<inherited_conversation>") < message.indexOf("<context>"));
    assert.ok(message.indexOf("<context>") < message.lastIndexOf("<task>"));
    assert.match(message, /text-only background/i);
    assert.match(message, /separate task block remains authoritative/);
  });
});

describe("buildChildArgs", () => {
  test("base invocation: rpc mode, no session, model, then env+policy prompt blocks", () => {
    const tmpDir = "/tmp/pi-subagent-x";
    const args = buildChildArgs("prov/model", {}, tmpDir);
    assert.deepEqual(args.slice(0, 6), [
      "--mode",
      "rpc",
      "--no-session",
      "--model",
      "prov/model",
      "--append-system-prompt",
    ]);
    const joined = args.join(" ");
    assert.ok(joined.includes(`<subagent_env>\nPI_SUBAGENT_TMPDIR=${tmpDir}`));
    assert.ok(joined.includes("<subagent_policy>"));
    assert.ok(!joined.includes("--tools"));
    assert.ok(!joined.includes("--exclude-tools"));
  });

  test("tools list → exact allowlist flag", () => {
    const args = buildChildArgs("m", { tools: ["read", "grep"] }, "/t");
    assert.ok(args.includes("--tools"));
    assert.equal(args[args.indexOf("--tools") + 1], "read,grep");
  });

  test("tools: [] → --no-tools (literally zero tools)", () => {
    const args = buildChildArgs("m", { tools: [] }, "/t");
    assert.ok(args.includes("--no-tools"));
    assert.ok(!args.includes("--tools"));
  });

  test("excludeTools → denylist flag; empty ≡ absent (no flag)", () => {
    const args = buildChildArgs("m", { excludeTools: ["ask_user"] }, "/t");
    assert.equal(args[args.indexOf("--exclude-tools") + 1], "ask_user");
    const empty = buildChildArgs("m", { excludeTools: [] }, "/t");
    assert.ok(!empty.includes("--exclude-tools"));
  });

  test("tools wins over excludeTools (both set is rejected upstream; belt only)", () => {
    const args = buildChildArgs("m", { tools: ["read"], excludeTools: ["bash"] }, "/t");
    assert.equal(args[args.indexOf("--tools") + 1], "read");
    assert.ok(!args.includes("--exclude-tools"));
  });

  test("policy is conditional on conversation inheritance", () => {
    const isolatedArgs = buildChildArgs("m", {}, "/t");
    assert.deepEqual(buildChildArgs("m", { inheritConversation: false }, "/t"), isolatedArgs);
    const isolated = isolatedArgs.join("\n");
    const inherited = buildChildArgs("m", { inheritConversation: true }, "/t").join("\n");
    assert.match(isolated, /you have NO prior conversation/);
    assert.ok(!isolated.includes("<inherited_conversation> block"));
    assert.match(inherited, /<inherited_conversation> block/);
    assert.match(inherited, /may be compacted or truncated/);
    assert.ok(!inherited.includes("you have NO prior conversation"));
  });

  test("thinking and role system prompt are wrapped in their blocks", () => {
    const args = buildChildArgs("m", { thinking: "high", systemPrompt: "  Be brief.  " }, "/t");
    assert.equal(args[args.indexOf("--thinking") + 1], "high");
    const roleIdx = args.findIndex((a) => a.startsWith("<subagent_role>"));
    assert.ok(roleIdx > 0);
    assert.equal(args[roleIdx], "<subagent_role>\nBe brief.\n</subagent_role>");
  });
});
