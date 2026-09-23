import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PeekContextOverflowError,
  type InvestigateOptions,
  type InvestigateResult,
  type PeekAPI,
  type PeekInvestigation,
  type PeekReferenceOptions,
} from "@d3ara1n/pi-peek";
import { PeekOverlay } from "./overlay.ts";

const result = (report: string, stopReason: "stop" | "length" = "stop"): InvestigateResult => ({
  report,
  snapshotAt: "2026-01-01T00:00:00Z",
  referenceLength: 10,
  stopReason,
  model: "fake/model",
  usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11, cost: 0 },
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function panel(api: PeekAPI, options: PeekReferenceOptions = {}) {
  const overlay = new PeekOverlay(
    { requestRender() {}, terminal: { rows: 40, columns: 100 } },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
    },
    () => {},
    {} as ExtensionContext,
    api,
    options,
  );
  const state = overlay as unknown as {
    submit(value: string): void;
    history: { role: string; text: string; notice?: string }[];
    streamText: string;
    mode: string;
  };
  return { overlay, state };
}
function apiFor(
  createInvestigation: (options?: PeekReferenceOptions) => PeekInvestigation,
): PeekAPI {
  return {
    createInvestigation,
    investigate: async () => {
      throw new Error("one-shot path must not be used by the overlay");
    },
    serializeMainConversation: () => {
      throw new Error("UI must not rebuild model history");
    },
    getMainAgentStatus: () => ({
      activity: "idle",
      toolIndex: 0,
      turn: 0,
      lastUpdated: "2026-01-01T00:00:00Z",
    }),
  };
}

test("overlay reuses one investigation for follow-ups and disposes on close", async () => {
  let created = 0;
  let disposed = 0;
  const questions: string[] = [];
  let shown = "";
  const investigation: PeekInvestigation = {
    snapshotAt: "2026-01-01T00:00:00Z",
    async investigate(question, opts) {
      questions.push(question);
      opts?.onStage?.("investigating");
      opts?.onToken?.(`Report ${questions.length}`);
      shown = state.streamText;
      return result(`Report ${questions.length}`);
    },
    dispose() {
      disposed++;
    },
  };
  const { overlay, state } = panel(
    apiFor((options) => {
      assert.equal(options?.includeThinking, undefined);
      created++;
      return investigation;
    }),
  );
  try {
    state.submit("first question");
    await flush();
    assert.equal(shown, "Report 1");
    state.submit("follow-up question");
    await flush();
    assert.equal(created, 1);
    assert.equal(shown, "Report 2");
    assert.deepEqual(questions, ["first question", "follow-up question"]);
    assert.deepEqual(
      state.history.map((h) => h.text),
      ["first question", "Report 1", "follow-up question", "Report 2"],
    );
  } finally {
    overlay.dispose();
  }
  assert.equal(disposed, 1);
  assert.equal(state.history.length, 0);
  overlay.dispose();
  assert.equal(disposed, 1);
});

test("explicit thinking mode is passed to investigation creation without adding default UI instructions", async () => {
  let includeThinking: boolean | undefined;
  const { overlay, state } = panel(
    apiFor((options) => {
      includeThinking = options?.includeThinking;
      return { snapshotAt: "fixed", investigate: async () => result("report"), dispose() {} };
    }),
    { includeThinking: true },
  );
  try {
    const screen = overlay.render(80).join("\n");
    assert.match(screen, /Investigate this session\./);
    assert.doesNotMatch(screen, /snapshot|search or expand|Follow-ups reuse|close and reopen/i);
    state.submit("question");
    await flush();
    assert.equal(includeThinking, true);
  } finally {
    overlay.dispose();
  }
});

test("output and context limits are separate notices, not additions to the report text", async () => {
  let turns = 0;
  const { overlay, state } = panel(
    apiFor(() => ({
      snapshotAt: "fixed",
      async investigate() {
        if (++turns === 2) throw new PeekContextOverflowError("prompt too long");
        return result("partial report", "length");
      },
      dispose() {},
    })),
  );
  try {
    state.submit("first");
    await flush();
    assert.equal(state.history[1]!.text, "partial report");
    assert.equal(state.history[1]!.notice, "Output limit reached");
    state.submit("second");
    await flush();
    assert.equal(state.history[1]!.text, "partial report");
    assert.equal(state.history[3]!.text, "");
    assert.equal(state.history[3]!.notice, "Context limit reached");
  } finally {
    overlay.dispose();
  }
});

test("investigation creation failures restore the input state instead of escaping submit", async () => {
  const { overlay, state } = panel(
    apiFor(() => {
      throw new Error("model unavailable");
    }),
  );
  try {
    state.submit("question");
    await flush();
    assert.equal(state.mode, "input");
    assert.match(state.history[1]!.text, /model unavailable/);
  } finally {
    overlay.dispose();
  }
});

test("closing the overlay aborts its request and ignores late output", async () => {
  let complete!: (value: InvestigateResult) => void;
  let signal: AbortSignal | undefined;
  let lateToken: ((text: string) => void) | undefined;
  const { overlay, state } = panel(
    apiFor(() => ({
      snapshotAt: "fixed",
      investigate(_question, opts) {
        signal = opts?.signal;
        lateToken = opts?.onToken;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
      dispose() {},
    })),
  );
  state.submit("question");
  await flush();
  overlay.dispose();
  assert.equal(signal?.aborted, true);
  lateToken?.("late text");
  complete(result("late report"));
  await flush();
  assert.equal(state.history.length, 0);
  assert.equal(state.streamText, "");
});

test("overlay shows investigation activities and live report character counts without thinking text", async () => {
  let options!: InvestigateOptions;
  let complete!: (value: InvestigateResult) => void;
  const { overlay, state } = panel(
    apiFor(() => ({
      snapshotAt: "fixed",
      investigate(_question, opts) {
        options = opts!;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
      dispose() {},
    })),
  );
  const screen = () => overlay.render(100).join("\n");
  try {
    state.submit("question");
    await flush();
    for (const stage of ["thinking", "searching", "reading", "outputting"] as const) {
      options.onProgress?.({
        stage,
        phase: "investigation",
        round: 2,
        maxRounds: 6,
        request: 2,
        toolCalls: 1,
        model: "fake/reasoner",
        chars: 0,
        elapsedMs: 20,
      });
      assert.match(screen(), new RegExp(`${stage}…`));
      assert.match(screen(), /fake\/reasoner/);
      assert.equal(state.streamText, "");
      assert.doesNotMatch(screen(), /0 chars/);
    }
    options.onToken?.("provisional");
    options.onReset?.();
    assert.equal(state.streamText, "");
    assert.doesNotMatch(screen(), /provisional/);
    options.onToken?.("A heading\n");
    assert.equal(state.streamText, "A heading\n");
    assert.match(screen(), /outputting… · 10 chars/);
    assert.match(screen(), /A heading/);
    options.onToken?.("Details");
    assert.match(screen(), /outputting… · 17 chars/);
    complete(result("A heading\nDetails"));
    await flush();
    assert.equal(state.history[1]?.text, "A heading\nDetails");
    assert.equal(state.streamText, "");
  } finally {
    overlay.dispose();
  }
});

test("overlay preserves interrupted streamed text with an independent error notice", async () => {
  const { overlay, state } = panel(
    apiFor(() => ({
      snapshotAt: "fixed",
      async investigate(_question, opts) {
        opts?.onToken?.("Partial **report**");
        throw new Error("connection lost");
      },
      dispose() {},
    })),
  );
  try {
    state.submit("question");
    await flush();
    assert.equal(state.history[1]?.text, "Partial **report**");
    assert.equal(state.history[1]?.notice, "Report interrupted: connection lost");
    assert.equal(state.mode, "input");
  } finally {
    overlay.dispose();
  }
});
