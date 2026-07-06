/**
 * Unit tests for pi-subagent pure helpers.
 *
 * Zero-dependency: runs on node's built-in test runner.
 *   node --test packages/pi-subagent/src/utils.test.ts
 *
 * These guard the bug fixes introduced during the improvement rounds:
 * path-injection (sanitizeFilename), concurrency/abort/negative-active
 * (AsyncSemaphore), provider-error word list (isProviderError), unknown-tool
 * formatting (previewArgs), output truncation fallback (truncateOutput).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeFilename,
  isProviderError,
  AsyncSemaphore,
  previewArgs,
  truncateOutput,
  formatTokens,
  effectiveTimeout,
  elapsedSeconds,
} from "./utils.ts";
import type { SubagentResult, SubagentRole } from "./types.ts";

// ── sanitizeFilename: guards the path-injection fix ──
describe("sanitizeFilename", () => {
  test("never yields a path separator (no directory traversal)", () => {
    // Core security contract: result contains no / or \, so it can't escape the dir via path.join.
    for (const input of ["../../etc", "../passwd", "/etc/passwd", "a/b/c", "a\\b", "..", "///"]) {
      const out = sanitizeFilename(input);
      assert.ok(!out.includes("/"), `${input} -> "${out}" still contains /`);
      assert.ok(!out.includes("\\"), `${input} -> "${out}" still contains \\`);
    }
  });
  test("empty string falls back to unknown", () => {
    assert.equal(sanitizeFilename(""), "unknown");
  });
  test("pure-dots collapses to unknown (leading dots stripped, rest empty)", () => {
    assert.equal(sanitizeFilename(".."), "unknown");
    assert.equal(sanitizeFilename("..."), "unknown");
  });
  test("special chars become underscores", () => {
    assert.equal(sanitizeFilename("!!!"), "___");
    assert.equal(sanitizeFilename("   "), "___");
    assert.equal(sanitizeFilename("///"), "___");
    assert.equal(sanitizeFilename("a/b/c"), "a_b_c");
  });
  test("keeps normal uuid/alnum/dots/dashes as-is", () => {
    const id = "019eff4f-b603-7623-9eaa-17d32eb623d9";
    assert.equal(sanitizeFilename(id), id);
    assert.equal(sanitizeFilename("call_abc123.json"), "call_abc123.json");
  });
});

// ── isProviderError: guards the #9 expanded word list ──
describe("isProviderError", () => {
  const mk = (stderr: string, errorMessage = ""): SubagentResult =>
    ({
      stderr,
      errorMessage,
      role: "",
      task: "",
      exitCode: 0,
      messages: [],
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      activityLog: [],
    }) as unknown as SubagentResult;

  test("matches provider error keywords", () => {
    const cases = [
      "429 Too Many Requests",
      "quota exceeded",
      "rate limit exceeded",
      "authentication error",
      "request timeout",
      "quota exhausted",
      "service unavailable",
      "503 Service Unavailable",
      "internal server error",
      "temporary failure",
      "request declined",
      "server overloaded",
      "ECONNRESET",
      "socket hang up",
      "EPIPE",
      "network error",
      "connection refused",
    ];
    for (const c of cases) {
      assert.equal(isProviderError(mk(c)), true, `should match: ${c}`);
    }
  });
  test("does not match business/programming errors", () => {
    assert.equal(isProviderError(mk("TypeError: Cannot read properties of undefined")), false);
    assert.equal(isProviderError(mk("Error: test failed, expected 5 got 3")), false);
    assert.equal(isProviderError(mk("AssertionError: values differ")), false);
    assert.equal(isProviderError(mk("")), false);
  });
  test("checks errorMessage too, not just stderr", () => {
    assert.equal(isProviderError(mk("", "rate limited")), true);
  });
});

// ── AsyncSemaphore: guards concurrency cap, negative-active, abort cleanup ──
describe("AsyncSemaphore", () => {
  test("never goes negative on extra release", async () => {
    const s = new AsyncSemaphore(1);
    await s.acquire();
    s.release();
    s.release();
    s.release();
    assert.equal((s as any).active, 0);
  });
  test("respects concurrency cap (queues beyond max)", async () => {
    const s = new AsyncSemaphore(2);
    await s.acquire();
    await s.acquire();
    let entered = false;
    const p = s.acquire().then(() => {
      entered = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(entered, false); // still queued
    s.release();
    await p;
    assert.equal(entered, true);
  });
  test("abort removes waiter from queue and rejects", async () => {
    const s = new AsyncSemaphore(1);
    await s.acquire();
    const c = new AbortController();
    const p = s.acquire(c.signal);
    c.abort();
    await assert.rejects(p);
    assert.equal((s as any).waiters.length, 0);
  });
  test("releases queued waiters in FIFO order", async () => {
    const s = new AsyncSemaphore(1);
    await s.acquire();
    const order: number[] = [];
    const p1 = s.acquire().then(() => order.push(1));
    const p2 = s.acquire().then(() => order.push(2));
    const p3 = s.acquire().then(() => order.push(3));
    s.release();
    await p1;
    s.release();
    await p2;
    s.release();
    await p3;
    assert.deepEqual(order, [1, 2, 3]);
  });
  test("acquires immediately when under cap", async () => {
    const s = new AsyncSemaphore(3);
    await s.acquire();
    await s.acquire();
    assert.equal((s as any).active, 2);
  });
});

// ── previewArgs: guards the #10 shape-based formatting ──
describe("previewArgs", () => {
  test("command -> $ prefix", () => {
    assert.equal(previewArgs({ command: "ls -la" }), "$ ls -la");
  });
  test("command truncated at 60 chars", () => {
    const long = "x".repeat(70);
    const r = previewArgs({ command: long });
    assert.ok(r.startsWith("$ "));
    assert.ok(r.endsWith("..."));
    assert.ok(r.length < long.length);
  });
  test("file_path is shortened (home -> ~)", () => {
    const r = previewArgs({ file_path: "/home/user/foo.ts" });
    assert.ok(r.includes("foo.ts"));
  });
  test("url passthrough (truncated when long)", () => {
    assert.equal(previewArgs({ url: "https://example.com" }), "https://example.com");
    const longUrl = "https://" + "x".repeat(70);
    assert.ok(previewArgs({ url: longUrl }).endsWith("..."));
  });
  test("query/pattern/regex/search -> /.../  form", () => {
    assert.equal(previewArgs({ query: "foo" }), "/foo/");
    assert.equal(previewArgs({ pattern: "bar" }), "/bar/");
    assert.equal(previewArgs({ regex: "baz" }), "/baz/");
    assert.equal(previewArgs({ search: "qux" }), "/qux/");
  });
  test("empty object falls back to JSON {}", () => {
    assert.equal(previewArgs({}), "{}");
  });
});

// ── effectiveTimeout: per-role timeout resolution (seconds) ──
describe("effectiveTimeout", () => {
  const role = (tools: string[], timeout?: number): SubagentRole =>
    ({
      role: "default",
      description: "",
      examples: [],
      decisionTrigger: "",
      tools,
      systemPrompt: "",
      timeout,
    }) as unknown as SubagentRole;

  test("non-delegate role uses base timeout", () => {
    assert.equal(effectiveTimeout(role(["read", "grep"]), 600), 600);
  });
  test("delegate role uses base timeout (no widening — active-time clock pauses for nested delegate)", () => {
    assert.equal(effectiveTimeout(role(["read", "delegate"]), 600), 600);
  });
  test("explicit roleDef.timeout is always honored (no widening)", () => {
    assert.equal(effectiveTimeout(role(["read", "delegate"], 300), 600), 300);
  });
  test("explicit timeout on non-delegate also honored", () => {
    assert.equal(effectiveTimeout(role(["read"]), 600), 600);
  });
});

// ── truncateOutput: guards the #2 head+tail fallback ──
describe("truncateOutput", () => {
  test("adds truncation header with original length", () => {
    const big = "x".repeat(60000);
    const r = truncateOutput(big);
    assert.ok(r.startsWith("[Output truncated"));
    assert.ok(r.includes("60000 chars total"));
    assert.ok(r.includes("[truncated]"));
  });
  test("keeps head and tail, drops the middle", () => {
    // 120000 chars: 40k H + 40k M + 40k T
    const content = "H".repeat(40000) + "M".repeat(40000) + "T".repeat(40000);
    const r = truncateOutput(content);
    assert.ok(r.includes("H"), "head preserved");
    assert.ok(r.includes("T"), "tail preserved");
    assert.ok(!r.includes("M"), "middle dropped");
  });
});

// ── formatTokens: boundary correctness ──
describe("formatTokens", () => {
  test("under 1000 stays raw", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
  });
  test("1000-9999 with one decimal place", () => {
    assert.equal(formatTokens(1000), "1.0k");
    assert.equal(formatTokens(9500), "9.5k");
    // 9999/1000 = 9.999, toFixed(1) rounds up to 10.0
    assert.equal(formatTokens(9999), "10.0k");
  });
  test("10000-999999 rounded to integer k", () => {
    assert.equal(formatTokens(10000), "10k");
    assert.equal(formatTokens(999999), "1000k");
  });
  test(">= 1000000 in M", () => {
    assert.equal(formatTokens(1000000), "1.0M");
  });
});

// ── elapsedSeconds: live/terminal time derivation ──
describe("elapsedSeconds", () => {
  test("terminal state: rounds elapsedMs to whole seconds", () => {
    assert.equal(elapsedSeconds({ exitCode: 0, elapsedMs: 12345 }), 12);
    assert.equal(elapsedSeconds({ exitCode: 0, elapsedMs: 400 }), 0);
    assert.equal(elapsedSeconds({ exitCode: 1, elapsedMs: 59999 }), 60);
  });
  test("terminal state without elapsedMs -> undefined", () => {
    assert.equal(elapsedSeconds({ exitCode: 0 }), undefined);
  });
  test("queued (running sentinel, no startTime) -> undefined", () => {
    assert.equal(elapsedSeconds({ exitCode: -1 }), undefined);
  });
  test("running: live seconds from startTime (within ~1s drift)", () => {
    const start = Date.now() - 3500;
    const s = elapsedSeconds({ exitCode: -1, startTime: start });
    assert.ok(s !== undefined, "should be defined while running");
    assert.ok(s >= 3 && s <= 4, `expected ~3s, got ${s}`);
  });
  test("running: clamps negative drift (future startTime) to 0", () => {
    const start = Date.now() + 10000; // 10s in the future
    assert.equal(elapsedSeconds({ exitCode: -1, startTime: start }), 0);
  });
});
