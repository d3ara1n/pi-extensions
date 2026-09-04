/**
 * Unit tests for pi-subagent pure helpers.
 *
 * Zero-dependency: runs on node's built-in test runner.
 *   node --test packages/pi-subagent/src/utils.test.ts
 *
 * Coverage highlights: path-injection safety (sanitizeFilename),
 * concurrency/abort/unlimited semantics (AsyncSemaphore), provider-error
 * heuristics (isProviderError), shared result-view composition
 * (terminalResultLine), time/budget formatting (formatTimePart), budget-stop
 * and fallback provenance notes, background-run helpers, and notification
 * throttling (createThrottler).
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
  formatInheritedConversationInput,
  formatUsageStats,
  effectiveTimeout,
  elapsedSeconds,
  hasFailedSubagentResult,
  buildFallbackFrom,
  formatFallback,
  FALLBACK_STDERR_TAIL,
  deriveRunState,
  isWaitTimedOut,
  describeCurrentActivity,
  formatUsageFooter,
  formatFallbackNote,
  formatBudgetNote,
  formatCheckText,
  formatCancelText,
  formatRunLine,
  formatTimePart,
  freezeFrame,
  createThrottler,
  terminalResultLine,
  buildDisplayItems,
  completionNoticeLines,
  formatToolCall,
  briefFilesUsed,
  collectDeliveredIds,
} from "./utils.ts";
import type { ActivityEntry, SubagentResult, SubagentRole } from "./types.ts";

/** Shared SubagentResult fixture. */
const baseResult = (overrides: Partial<SubagentResult> = {}): SubagentResult => ({
  role: "worker",
  task: "test task",
  exitCode: 0,
  output: "ok",
  stderr: "",
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
  ...overrides,
});

describe("subagent failure details", () => {

  test("detects failed delegate results for tool_result error marking", () => {
    assert.equal(
      hasFailedSubagentResult({ results: [baseResult({ exitCode: 1 })] }),
      true,
    );
    assert.equal(
      hasFailedSubagentResult({ results: [baseResult({ stopReason: "timeout" })] }),
      true,
    );
  });

  test("does not mark successful or malformed details as failed", () => {
    assert.equal(hasFailedSubagentResult({ results: [baseResult()] }), false);
    assert.equal(hasFailedSubagentResult({ results: [] }), false);
    assert.equal(hasFailedSubagentResult(undefined), false);
    assert.equal(hasFailedSubagentResult({}), false);
  });
});

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
  const mk = (stderr: string, errorMessage = ""): SubagentResult => baseResult({ stderr, errorMessage });

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
  test("unlimited max (0) never queues or reports capacity", async () => {
    const s = new AsyncSemaphore(0);
    assert.equal(s.isLimited, false);
    assert.equal(s.isAtCapacity, false);

    let acquired = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        s.acquire().then(() => {
          acquired++;
        }),
      ),
    );

    assert.equal(acquired, 10);
    assert.equal((s as any).waiters.length, 0);
    assert.equal(s.isAtCapacity, false);
  });
  test("positive max reports capacity and retains FIFO queueing", async () => {
    const s = new AsyncSemaphore(1);
    await s.acquire();
    assert.equal(s.isAtCapacity, true);

    const order: number[] = [];
    const p1 = s.acquire().then(() => order.push(1));
    const p2 = s.acquire().then(() => order.push(2));
    assert.equal((s as any).waiters.length, 2);

    s.release();
    await p1;
    s.release();
    await p2;
    assert.deepEqual(order, [1, 2]);
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
  test("command is preserved for viewport-aware truncation", () => {
    const long = "x".repeat(70);
    assert.equal(previewArgs({ command: long }), `$ ${long}`);
  });
  test("file_path is shortened (home -> ~)", () => {
    const r = previewArgs({ file_path: "/home/user/foo.ts" });
    assert.ok(r.includes("foo.ts"));
  });
  test("url is preserved for viewport-aware truncation", () => {
    assert.equal(previewArgs({ url: "https://example.com" }), "https://example.com");
    const longUrl = "https://" + "x".repeat(70);
    assert.equal(previewArgs({ url: longUrl }), longUrl);
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

  test("role without timeout is unlimited", () => {
    assert.equal(effectiveTimeout(role(["read", "grep"])), 0);
  });
  test("delegate-capable role without timeout is also unlimited", () => {
    assert.equal(effectiveTimeout(role(["read", "subagent_delegate"])), 0);
  });
  test("explicit role timeout is honored", () => {
    assert.equal(effectiveTimeout(role(["read", "subagent_delegate"], 300)), 300);
  });
  test("negative and non-finite values normalize to unlimited", () => {
    assert.equal(effectiveTimeout(role(["read"], -1)), 0);
    assert.equal(effectiveTimeout(role(["read"], Number.POSITIVE_INFINITY)), 0);
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

// ── inherited-conversation input metadata ──
describe("formatInheritedConversationInput", () => {
  test("formats delivered chars, truncation, and empty inheritance", () => {
    assert.equal(formatInheritedConversationInput(42, false), "conversation 42 chars");
    assert.equal(
      formatInheritedConversationInput(50_000, true),
      "conversation 50000 chars · truncated",
    );
    assert.equal(formatInheritedConversationInput(0, false), "conversation inherited · empty");
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

// ── formatTimePart: shared elapsed/budget(+grace) text ──
describe("formatTimePart", () => {
  test("running frame with budget and grace", () => {
    const r = { exitCode: -1, startTime: Date.now() - 42000, budgetMs: 900000, graceMs: 3000 };
    assert.equal(formatTimePart(r), "42s/900s(+3s)");
  });
  test("running frame without budget", () => {
    const r = { exitCode: -1, startTime: Date.now() - 3000 };
    assert.equal(formatTimePart(r), "3s");
  });
  test("terminal frame uses the frozen elapsedMs", () => {
    assert.equal(formatTimePart({ exitCode: 0, elapsedMs: 5000, budgetMs: 900000 }), "5s/900s");
  });
  test("queued frame has no time", () => {
    assert.equal(formatTimePart({ exitCode: -1 }), null);
  });
});

// ── terminalResultLine: one chain for every result view ──
describe("terminalResultLine", () => {
  const id = (_color: string, text: string) => text;

  test("failure shows the error message in error styling", () => {
    assert.equal(
      terminalResultLine(baseResult({ exitCode: 1, errorMessage: "boom" }), id),
      "\u2717 boom",
    );
  });
  test("timeout/budget map to the warning styling", () => {
    assert.equal(
      terminalResultLine(baseResult({ stopReason: "timeout", exitCode: 124, errorMessage: "Timed out after 900s" }), id),
      "\u23F1 Timed out after 900s",
    );
  });
  test("budget-exceeded is a warning line even though the run state is finished", () => {
    assert.equal(
      terminalResultLine(
        baseResult({ stopReason: "budget_exceeded", errorMessage: "Budget exceeded (50 turns; partial output returned)" }),
        id,
      ),
      "\u23F2 Budget exceeded (50 turns; partial output returned)",
    );
  });
  test("cancelled maps to the ⏹ warning styling like timeout/budget", () => {
    assert.equal(
      terminalResultLine(
        baseResult({ exitCode: 1, stopReason: "cancelled", errorMessage: "user: wrong direction" }),
        id,
      ),
      "\u23F9 user: wrong direction",
    );
  });
  test("success chain: AI summary wins, then output first line, then placeholder", () => {
    assert.equal(terminalResultLine(baseResult({ summary: "did the thing" }), id), "\u2713 did the thing");
    assert.equal(terminalResultLine(baseResult(), id), "\u2713 ok");
    assert.equal(terminalResultLine(baseResult({ output: "" }), id), "\u2713 (no output)");
  });
  test("finishedText replaces the success chain (wait's status-only line)", () => {
    assert.equal(terminalResultLine(baseResult(), id, "finished"), "\u2713 finished");
  });
  test("error message newlines are flattened to one line", () => {
    assert.equal(
      terminalResultLine(baseResult({ exitCode: 1, errorMessage: "boom\n  at frame 2\nat frame 3" }), id),
      "\u2717 boom at frame 2 at frame 3",
    );
  });
});

// ── completionNoticeLines: background-run completion notice card ──
describe("completionNoticeLines", () => {
  // Marker fakes so assertions can see both text and color placement.
  const fg = (color: string, text: string) => `<${color}>${text}</${color}>`;
  const bold = (text: string) => `*${text}*`;

  test("header: bracket label + id (role) + plain-text outcome", () => {
    assert.deepEqual(
      completionNoticeLines({ id: "sub-3", role: "worker", outcome: "finished" }, fg, bold),
      [
        "<customMessageLabel>*[subagent]*</customMessageLabel> " +
          "<customMessageText>sub-3 (worker)</customMessageText> " +
          "<customMessageText>finished</customMessageText>",
      ],
    );
  });

  test("failed colors the outcome error-red, cancelled warning-yellow", () => {
    const failed = completionNoticeLines({ id: "sub-1", role: "x", outcome: "failed" }, fg, bold)[0];
    assert.ok(failed.includes("<error>failed</error>"));
    const cancelled = completionNoticeLines(
      { id: "sub-1", role: "x", outcome: "cancelled" },
      fg,
      bold,
    )[0];
    assert.ok(cancelled.includes("<warning>cancelled</warning>"));
  });

  test("task preview on its own line without a prefix, newlines flattened", () => {
    const lines = completionNoticeLines(
      {
        id: "sub-2",
        role: "explorer",
        outcome: "finished",
        task: "Map the routing\nstructure",
      },
      fg,
      bold,
    );
    assert.deepEqual(lines[1], "<dim>Map the routing structure</dim>");
  });

  test("whitespace-only task: header-only notice", () => {
    assert.deepEqual(
      completionNoticeLines(
        { id: "sub-4", role: "worker", outcome: "finished", task: "  " },
        fg,
        bold,
      ).length,
      1,
    );
  });
});

// ── formatToolCall: single-line guarantee for TUI rows ──
describe("formatToolCall newline sanitization", () => {
  const id = (_color: string, text: string) => text;

  test("multi-line bash command renders as one line", () => {
    const out = formatToolCall("bash", { command: "echo a\necho b\n  echo c" }, id);
    assert.ok(!out.includes("\n"));
    assert.equal(out, "$ echo a echo b echo c");
  });
  test("default branch preview flattens embedded newlines", () => {
    const out = formatToolCall("fetch", { url: "https://x.test/a\n/b" }, id);
    assert.ok(!out.includes("\n"));
    assert.ok(out.includes("https://x.test/a /b"));
  });
});

// ── createThrottler: burst coalescing for onUpdate ──
describe("createThrottler", () => {
  test("coalesces a burst into one fire per window", async () => {
    let fired = 0;
    const t = createThrottler(() => fired++);
    t.notify();
    t.notify();
    t.notify();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fired, 1);
  });
  test("cancel drops the pending fire", async () => {
    let fired = 0;
    const t = createThrottler(() => fired++);
    t.notify();
    t.cancel();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fired, 0);
  });
});

describe("fallback observability", () => {
  const failed = (overrides: Partial<SubagentResult> = {}): SubagentResult =>
    baseResult({
      role: "researcher",
      exitCode: 1,
      model: "opencode-go/deepseek-v4-flash",
      stopReason: "timeout",
      errorMessage: "Timed out after 900s",
      ...overrides,
    });

  test("buildFallbackFrom snapshots the failed attempt", () => {
    const f = buildFallbackFrom(failed());
    assert.equal(f.model, "opencode-go/deepseek-v4-flash");
    assert.equal(f.stopReason, "timeout");
    assert.equal(f.errorMessage, "Timed out after 900s");
    assert.equal(f.stderrTail, undefined);
  });

  test("buildFallbackFrom keeps a truncated stderr tail", () => {
    const noise = "x".repeat(2000);
    const f = buildFallbackFrom(failed({ stderr: `${noise}HTTP 429 at tail` }));
    assert.ok(f.stderrTail!.endsWith("HTTP 429 at tail"));
    assert.ok(f.stderrTail!.length <= FALLBACK_STDERR_TAIL);
  });

  test("buildFallbackFrom drops whitespace-only stderr", () => {
    const f = buildFallbackFrom(failed({ stderr: "   \n\t " }));
    assert.equal(f.stderrTail, undefined);
  });

  test("formatFallback prefers errorMessage", () => {
    assert.equal(
      formatFallback({ model: "ds", stopReason: "timeout", errorMessage: "boom" }),
      "first attempt ds failed (boom)",
    );
  });

  test("formatFallback falls back to stopReason then a generic label", () => {
    assert.equal(formatFallback({ model: "ds", stopReason: "timeout" }), "first attempt ds failed (timeout)");
    assert.equal(formatFallback({}), "first attempt unknown model failed (provider error)");
  });

  test("formatFallback keeps a single truncated line", () => {
    assert.equal(formatFallback({ model: "ds", errorMessage: "line1\nline2" }), "first attempt ds failed (line1)");
    const long = "y".repeat(150);
    const out = formatFallback({ model: "ds", errorMessage: long });
    assert.equal(out, `first attempt ds failed (${"y".repeat(100)}...)`);
    assert.ok(out.endsWith("...)"));
  });

  test("buildFallbackFrom fills model from the requested model when the child died early", () => {
    const f = buildFallbackFrom(failed({ model: undefined }), "opencode-go/deepseek-v4-flash");
    assert.equal(f.model, "opencode-go/deepseek-v4-flash");
  });

  test("buildFallbackFrom derives a reason from stderr when errorMessage is unset", () => {
    const f = buildFallbackFrom(
      failed({ errorMessage: undefined, stderr: "\x1b[2Knoise\nError: 429 Too Many Requests\n\x1b[?25h" }),
    );
    assert.equal(f.errorMessage, "Error: 429 Too Many Requests");
  });

  test("an explicit errorMessage wins over stderr", () => {
    const f = buildFallbackFrom(failed({ stderr: "connection reset by peer 429" }));
    assert.equal(f.errorMessage, "Timed out after 900s");
  });

  test("formatFallback shows the error message, never raw stderr content", () => {
    const f = buildFallbackFrom(failed({ stderr: "CONNECTIVITY monster line mentioning 429" }));
    const out = formatFallback(f);
    assert.ok(out.includes("Timed out after 900s"));
    assert.ok(!out.includes("CONNECTIVITY"));
  });
});

describe("background run helpers", () => {
  const queuedFrame = () => baseResult({ exitCode: -1, queued: true });
  const runningFrame = () => baseResult({ exitCode: -1 });

  test("deriveRunState maps frames to lifecycle states", () => {
    assert.equal(deriveRunState(queuedFrame()), "queued");
    assert.equal(deriveRunState(runningFrame()), "running");
    assert.equal(deriveRunState(baseResult()), "finished");
    assert.equal(deriveRunState(baseResult({ exitCode: 1 })), "failed");
    assert.equal(deriveRunState(baseResult({ stopReason: "timeout", exitCode: 124 })), "failed");
    // cancelled stops are failures with partial output (same family as timeout)
    assert.equal(deriveRunState(baseResult({ stopReason: "cancelled" })), "failed");
    // budget stops are intentional finishes
    assert.equal(deriveRunState(baseResult({ stopReason: "budget_exceeded" })), "finished");
  });

  test("isWaitTimedOut only matches the explicit timeout flag", () => {
    assert.equal(isWaitTimedOut({ entries: [], timedOut: true }), true);
    assert.equal(isWaitTimedOut({ entries: [] }), false);
    assert.equal(isWaitTimedOut(undefined), false);
  });

  test("describeCurrentActivity reports the latest activity item", () => {
    assert.equal(describeCurrentActivity(runningFrame()), "waiting for first event");
    const thinking = runningFrame();
    thinking.activityLog = [{ kind: "thinking", id: "thinking-0", status: "running" }];
    assert.equal(describeCurrentActivity(thinking), "thinking");
    const withTool = runningFrame();
    withTool.activityLog = [
      { kind: "thinking", id: "thinking-0", status: "done" },
      { kind: "toolCall", id: "t1", status: "running", toolName: "bash", args: { command: "ls" } },
    ];
    assert.equal(describeCurrentActivity(withTool), "$ ls");
  });

  test("formatUsageFooter renders turns, elapsed, tokens, cost, and model", () => {
    assert.equal(formatUsageFooter(baseResult()), "");
    const r = baseResult({
      elapsedMs: 135000,
      usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 0, turns: 2 },
      model: "test/model-x",
    });
    assert.equal(formatUsageFooter(r), "\n\n--- 2 turns ~135s \u21911.2k \u2193300 $0.5000 test/model-x ---");
  });

  test("formatUsageStats adds cache and peak-context figures the footer omits", () => {
    const usage = { input: 1200, output: 300, cacheRead: 900, cacheWrite: 100, cost: 0.5, contextTokens: 45000, turns: 2 };
    assert.equal(
      formatUsageStats(usage, "test/model-x"),
      "2 turns \u21911.2k \u2193300 R900 W100 ctx45k $0.5000 test/model-x",
    );
    // Footer stays lean — no cache/context parts.
    assert.equal(
      formatUsageFooter(baseResult({ usage, model: "test/model-x" })),
      "\n\n--- 2 turns \u21911.2k \u2193300 $0.5000 test/model-x ---",
    );
  });

  test("formatBudgetNote flags budget-stopped output as partial", () => {
    assert.equal(formatBudgetNote(baseResult()), "");
    assert.equal(
      formatBudgetNote(baseResult({ stopReason: "budget_exceeded", errorMessage: "Budget exceeded (50 turns)" })),
      "\n\n--- Budget exceeded (50 turns) ---",
    );
  });

  test("formatFallbackNote is empty without a retry and descriptive with one", () => {
    assert.equal(formatFallbackNote(baseResult()), "");
    const r = baseResult({
      fallbackFrom: { model: "primary/m1", errorMessage: "429 quota exceeded" },
      model: "fallback/m2",
    });
    assert.equal(
      formatFallbackNote(r),
      "\n\n--- fallback: first attempt primary/m1 failed (429 quota exceeded); retried on fallback/m2 ---",
    );
  });

  test("formatCheckText covers all four run states", () => {
    assert.match(formatCheckText("sub-1", "explorer", queuedFrame()), /^sub-1 \(explorer\): queued —/);
    assert.match(formatCheckText("sub-1", "explorer", runningFrame()), /^sub-1 \(explorer\): running — /);
    assert.match(
      formatCheckText("sub-1", "explorer", baseResult({ exitCode: 1, errorMessage: "boom" })),
      /^sub-1 \(explorer\): failed — boom\n\nPartial output:\nok$/,
    );
    assert.match(formatCheckText("sub-1", "explorer", baseResult()), /^sub-1 \(explorer\): finished\n\nok$/);
  });

  test("formatCheckText running carries elapsed/budget in the head and a usage footer", () => {
    const r = runningFrame();
    r.startTime = Date.now() - 135000;
    r.budgetMs = 300000;
    r.usage = { input: 8000, output: 900, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 2 };
    const text = formatCheckText("sub-1", "explorer", r);
    assert.match(text, /^sub-1 \(explorer\): running — waiting for first event \(135s\/300s\)/);
    assert.match(text, /\n\n--- 2 turns \u21918.0k \u2193900 \$0\.0200 ---$/);
  });

  test("formatRunLine is the shared roll-call line for wait and cancel", () => {
    assert.equal(formatRunLine("sub-1", "explorer", queuedFrame()), "sub-1 (explorer): queued");
    assert.equal(formatRunLine("sub-1", "explorer", baseResult()), "sub-1 (explorer): finished");
    const finished = baseResult({
      elapsedMs: 120000,
      usage: { input: 12000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 3 },
    });
    assert.equal(
      formatRunLine("sub-1", "explorer", finished),
      "sub-1 (explorer): finished (3 turns ~120s \u219112k \u21931.0k $0.0100)",
    );
  });

  test("formatCheckText renders cancelled with reason, partial output, and usage", () => {
    assert.match(
      formatCheckText(
        "sub-1",
        "explorer",
        baseResult({
          exitCode: 1,
          stopReason: "cancelled",
          errorMessage: "user: wrong direction",
          elapsedMs: 45000,
          usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 0, turns: 3 },
        }),
      ),
      /^sub-1 \(explorer\): cancelled — user: wrong direction\n\nPartial output:\nok\n\n--- 3 turns ~45s \u21911.0k \u2193200 \$0\.1000 ---$/,
    );
    // Queue-time cancel: never spawned — nothing to show past the head.
    assert.equal(
      formatCheckText(
        "sub-2",
        "worker",
        baseResult({ exitCode: 1, stopReason: "cancelled", errorMessage: "still queued (user: x)" }),
      ),
      "sub-2 (worker): cancelled — never started",
    );
  });

  test("formatCancelText distinguishes never-started cancels from mid-run cancels", () => {
    // Never-started cancel (gate/model-resolution phase): terminal frame has
    // no elapsedMs and zero usage — nothing ran. Mirrors the real terminal
    // shape (run.ts settles aborts via inputFrame(1, false)).
    assert.equal(
      formatCancelText("sub-1", "explorer", baseResult({ exitCode: 1, stopReason: "cancelled", output: "" })),
      "sub-1 (explorer): cancelled — never started",
    );
    // Mid-run cancel: real terminal shape — elapsedMs frozen, no startTime.
    const midRun = baseResult({
      exitCode: 1,
      stopReason: "cancelled",
      elapsedMs: 45000,
      output: "partial findings",
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 0, turns: 3 },
    });
    assert.equal(
      formatCancelText("sub-2", "worker", midRun),
      "sub-2 (worker): cancelled (3 turns ~45s \u21911.0k \u2193200 $0.1000) — partial output kept; subagent_check(sub-2) returns it.",
    );
    // Aborted before the first completed turn: elapsed-only stats.
    const underATurn = baseResult({
      exitCode: 1,
      stopReason: "cancelled",
      elapsedMs: 2000,
      output: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    });
    assert.equal(formatCancelText("sub-3", "worker", underATurn), "sub-3 (worker): cancelled (~2s)");
  });

  test("formatCheckText flags budget-stopped runs as partial on the finished line", () => {
    const r = baseResult({ stopReason: "budget_exceeded", errorMessage: "Budget exceeded (50 turns)" });
    assert.match(
      formatCheckText("sub-1", "explorer", r),
      /^sub-1 \(explorer\): finished\n\nok\n\n--- Budget exceeded \(50 turns\) ---$/,
    );
  });

  test("formatCheckText keeps the fallback note on failed runs too", () => {
    const r = baseResult({
      exitCode: 1,
      errorMessage: "boom",
      fallbackFrom: { model: "primary/m1", errorMessage: "429 quota exceeded" },
      model: "fallback/m2",
    });
    assert.match(
      formatCheckText("sub-1", "explorer", r),
      /failed — boom\n\nPartial output:\nok\n\n--- fallback: first attempt primary\/m1 failed \(429 quota exceeded\); retried on fallback\/m2 ---$/,
    );
  });

  test("freezeFrame stops the elapsed clock and folds the open pause into grace", () => {
    const start = Date.now() - 5000;
    const pausedAt = Date.now() - 2000;
    const frozen = freezeFrame(baseResult({
      exitCode: -1,
      startTime: start,
      budgetMs: 60000,
      graceMs: 1000,
      pauseStart: pausedAt,
    }));
    assert.equal(frozen.startTime, undefined);
    assert.equal(frozen.pauseStart, undefined);
    assert.ok(frozen.elapsedMs! >= 4990 && frozen.elapsedMs! <= 5010, `elapsedMs ~5000, got ${frozen.elapsedMs}`);
    assert.ok(frozen.graceMs! >= 3000 && frozen.graceMs! <= 3010, `graceMs ~3000, got ${frozen.graceMs}`);
  });
});

describe("streamed-text activity entries", () => {
  const textEntry = (status: ActivityEntry["status"], text?: string): ActivityEntry => ({
    kind: "text",
    id: "text-0",
    status,
    ...(text !== undefined ? { text } : {}),
  });

  test("buildDisplayItems excludes text entries (view-only content)", () => {
    const log: ActivityEntry[] = [
      { kind: "thinking", id: "thinking-0", status: "done" },
      { kind: "toolCall", id: "call-1", status: "done", toolName: "bash", args: { command: "ls" } },
      textEntry("done", "partial answer"),
    ];
    const items = buildDisplayItems(log);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.type), ["thinking", "toolCall"]);
  });

  test("buildDisplayItems returns empty for a text-only log", () => {
    assert.deepEqual(buildDisplayItems([textEntry("running", "streaming...")]), []);
  });

  test("describeCurrentActivity reports responding for a running text entry", () => {
    assert.equal(
      describeCurrentActivity({ activityLog: [textEntry("running", "hello")] }),
      "responding",
    );
    assert.equal(
      describeCurrentActivity({ activityLog: [textEntry("done", "hello")] }),
      "responded",
    );
  });
});

describe("briefFilesUsed", () => {
  const call = (toolName: string, args: Record<string, any>): ActivityEntry => ({
    kind: "toolCall",
    id: `tc-${toolName}`,
    status: "done",
    toolName,
    args,
  });
  const F1 = "/Users/x/proj/src/a.ts";
  const F2 = "/Users/x/proj/docs/guide.md";

  test("marks a file matched by an exact-path arg", () => {
    const used = briefFilesUsed([F1, F2], [call("read", { file_path: F1 })]);
    assert.equal(used.get(F1), true);
    assert.equal(used.get(F2), false);
  });

  test("marks a file referenced inside a bash command", () => {
    const used = briefFilesUsed([F1], [call("bash", { command: `cat ${F1} | head -5` })]);
    assert.equal(used.get(F1), true);
  });

  test("marks a file the child addressed by relative path", () => {
    const used = briefFilesUsed([F1], [call("edit", { file_path: "src/a.ts" })]);
    assert.equal(used.get(F1), true);
  });

  test("ignores short separator-less values — no false positives", () => {
    const used = briefFilesUsed([F1], [call("grep", { pattern: "a.ts" })]);
    assert.equal(used.get(F1), false);
  });

  test("collects strings from nested args one level deep", () => {
    const used = briefFilesUsed([F1], [
      call("edit", { edits: [{ oldText: "x", path: F1 }] }),
    ]);
    assert.equal(used.get(F1), true);
  });

  test("skips non-toolCall entries and empty file lists", () => {
    assert.equal(briefFilesUsed(undefined, [call("read", { file_path: F1 })]).size, 0);
    const used = briefFilesUsed([F1], [
      { kind: "text", id: "text-0", status: "done", text: "hi" },
    ]);
    assert.equal(used.get(F1), false);
  });
});

describe("collectDeliveredIds", () => {
  // A check tool result carrying a terminal snapshot (exitCode >= 0) —
  // the shape the check tool persists into the session tree.
  const checkEntry = (id: string, exitCode = 0) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "subagent_check",
      details: { id, role: "worker", result: { exitCode } },
    },
  });

  test("collects ids from subagent_check tool results only", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", content: [] } },
      { type: "message", message: { role: "toolResult", toolName: "read", details: { id: "sub-9" } } },
      { type: "message", message: { role: "toolResult", toolName: "subagent_wait", details: { entries: [] } } },
      checkEntry("sub-1"),
      { type: "message", message: { role: "custom", customType: "subagent-completion" } },
      { type: "compaction" },
    ];
    assert.deepEqual(collectDeliveredIds(entries), new Set(["sub-1"]));
  });

  test("dedupes repeated checks of the same id", () => {
    assert.deepEqual(collectDeliveredIds([checkEntry("sub-1"), checkEntry("sub-1")]), new Set(["sub-1"]));
  });

  test("a check of a live frame never delivers (stale peek must not silence the inbox)", () => {
    const entries = [checkEntry("sub-1", -1), checkEntry("sub-2")];
    assert.deepEqual(collectDeliveredIds(entries), new Set(["sub-2"]));
  });

  test("empty path means nothing delivered (branch rewound past the check)", () => {
    assert.equal(collectDeliveredIds([]).size, 0);
  });

  test("ignores malformed details", () => {
    const entries = [
      { type: "message", message: { role: "toolResult", toolName: "subagent_check" } },
      { type: "message", message: { role: "toolResult", toolName: "subagent_check", details: {} } },
      { type: "message", message: { role: "toolResult", toolName: "subagent_check", details: { id: 42 } } },
      {
        type: "message",
        message: { role: "toolResult", toolName: "subagent_check", details: { id: "sub-1", result: {} } },
      },
    ];
    assert.equal(collectDeliveredIds(entries).size, 0);
  });
});
