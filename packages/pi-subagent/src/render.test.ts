/** Tests for delegate and background-run TUI observability. */

import assert from "node:assert/strict";
import test from "node:test";
import { renderBackgroundDelegateCall, renderBackgroundDelegateResult, renderWaitResult, renderCheckResult } from "./render-async.ts";
import { renderDelegateCall, renderDelegateResult } from "./render.ts";
import type { SubagentResult } from "./types.ts";

test("delegate, wait, and check preserve steer rows through consumption and completion", () => {
  const run: SubagentResult = {
    role: "worker", task: "task", exitCode: -1, output: "", stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
    activityLog: [
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "toolCall" as const, id: `t${i}`, toolName: `tool${i}`, status: "done" as const })),
      { kind: "steer", id: "s", status: "queued", text: "correction ".repeat(30) },
    ],
  };
  const renderers = [
    () => ({ render: renderDelegateResult, details: { results: [run] } }),
    () => ({ render: renderWaitResult, details: { entries: [{ id: "sub-1", role: "worker", result: run }] } }),
    () => ({ render: renderCheckResult, details: { id: "sub-1", role: "worker", result: run } }),
  ];
  for (const make of renderers) {
    for (const expanded of [false, true]) {
      for (const width of [40, 100]) {
        const { render, details } = make();
        const draw = () => render({ content: [], details } as any, { expanded, isPartial: true }, theme, { state: {} } as any)
          .render(width).map((line) => line.trimEnd());
        run.exitCode = -1;
        run.activityLog.at(-1)!.status = "queued";
        const pending = draw();
        const index = pending.findIndex((line) => line.includes("steer (queued):"));
        assert.ok(index >= 0);
        assert.ok(expanded || !pending.join("\n").includes("tool1"));
        run.activityLog.at(-1)!.status = "done";
        const consumed = draw();
        assert.equal(consumed.length, pending.length);
        assert.ok(consumed[index].includes("steer:"));
        assert.ok(!consumed[index].includes("(queued)"));
        if (expanded) {
          run.exitCode = 0;
          assert.ok(draw().some((line) => line.includes("steer:")));
        }
      }
    }
  }
});

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function rendered(component: { render(width: number): string[] }): string {
  return component
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

test("delegate call titles mark inherited conversation without changing isolated mode", () => {
  const isolated = rendered(renderDelegateCall({ role: "worker" } as any, theme, {} as any));
  const inherited = rendered(
    renderDelegateCall({ role: "worker", inheritConversation: true } as any, theme, {} as any),
  );

  assert.equal(isolated, "subagent_delegate worker");
  assert.equal(inherited, "subagent_delegate worker (inherits conversation)");
});

test("background call and expanded input expose only safe inheritance metadata", () => {
  const call = rendered(
    renderBackgroundDelegateCall(
      { role: "worker", background: true, inheritConversation: true } as any,
      theme,
      {} as any,
    ),
  );
  assert.equal(call, "subagent_delegate worker (background · inherits conversation)");

  const result = rendered(
    renderBackgroundDelegateResult(
      {
        content: [{ type: "text", text: "started" }],
        details: {
          id: "sub-1",
          role: "worker",
          task: "Implement the delta",
          context: "explicit context",
          inheritConversation: true,
          inheritedConversationChars: 50_000,
          inheritedConversationTruncated: true,
        },
      } as any,
      { expanded: true, isPartial: false },
      theme,
      {} as any,
    ),
  );

  assert.match(result, /ctx 16 chars/);
  assert.match(result, /conversation 50000 chars · truncated/);
  assert.ok(!result.includes("inherited_conversation"));
});
