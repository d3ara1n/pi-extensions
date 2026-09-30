import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionSnapshot } from "./snapshot.ts";
import { executeSnapshotTool } from "./retrieval.ts";

type Messages = ConstructorParameters<typeof SessionSnapshot>[0];
const messages = (value: unknown[]) => value as Messages;
const read = (snapshot: SessionSnapshot, id: string) => snapshot.read([id]);

const source = () =>
  messages([
    { role: "user", content: "Why did the edit fail?", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private rationale", thinkingSignature: "opaque signature" },
        { type: "thinking", thinking: "redacted rationale", redacted: true },
        { type: "text", text: "Checking the file." },
        {
          type: "toolCall",
          id: "call1",
          name: "edit",
          arguments: { path: "a.ts", oldText: "old-value" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call1",
      toolName: "edit",
      isError: true,
      content: [
        { type: "text", text: "The operation failed: distinctive-error $& $1." },
        { type: "image", data: "SECRET_BASE64" },
      ],
      details: {
        patch: "saved patch",
        files: [{ path: "a.ts", diff: "-removed", unrelated: "private metadata" }],
      },
    },
  ]);

test("outlines retain dialogue and references while retrieval pairs exact arguments with results", () => {
  const input = source();
  const snapshot = new SessionSnapshot(input);
  const outline = snapshot.outline();
  assert.match(outline, /Why did the edit fail\?|Checking the file/);
  assert.match(outline, /\[toolcall id=T1 name="edit" status=error/);
  assert.doesNotMatch(outline, /old-value|distinctive-error|saved patch|private rationale/);
  const page = read(snapshot, "T1").records[0]!;
  assert.match(page.text!, /old-value/);
  assert.match(page.text!, /distinctive-error \$& \$1/);
  assert.match(page.text!, /saved patch|removed/);
  assert.doesNotMatch(page.text!, /SECRET_BASE64|private metadata/);
  (input[2] as any).content[0].text = "mutated later";
  assert.doesNotMatch(read(snapshot, "T1").records[0]!.text!, /mutated later/);
  assert.match(JSON.stringify(snapshot.search("distinctive-error")), /T1/);
});

test("thinking opt-out removes the records from every retrieval path", () => {
  const excluded = new SessionSnapshot(source());
  assert.doesNotMatch(
    excluded.reference(),
    /private rationale|redacted rationale|opaque signature/,
  );
  assert.deepEqual((excluded.search("private rationale") as any).matches, []);
  assert.ok(read(excluded, "H1").records[0]!.error);
  const included = new SessionSnapshot(source(), { includeThinking: true });
  assert.match(included.outline(), /\[thinking id=H1/);
  assert.doesNotMatch(included.outline(), /private rationale/);
  assert.match(read(included, "H1").records[0]!.text!, /private rationale/);
  assert.doesNotMatch(included.reference(), /redacted rationale|opaque signature/);
});

test("outlines preserve complete long dialogue and every block in chronological order", () => {
  const body = "HEAD" + "界".repeat(20000) + "TAIL-needle";
  const snapshot = new SessionSnapshot(
    messages([
      { role: "user", content: body },
      ...Array.from({ length: 120 }, (_, i) => ({
        role: "assistant",
        content: [{ type: "text", text: `record-${i}: ${"x".repeat(600)}` }],
      })),
    ]),
  );
  const outline = snapshot.outline();
  assert.ok(outline.includes(body));
  let previous = outline.indexOf(body);
  for (let i = 0; i < 120; i++) {
    const current = outline.indexOf(`record-${i}: ${"x".repeat(600)}`);
    assert.ok(current > previous);
    previous = current;
  }
  assert.match(JSON.stringify(snapshot.search("tail-NEEDLE")), /U1/);
  assert.equal(read(snapshot, "U1").records[0]!.text, body);
  const first = snapshot.search("record-", 0, 2) as any;
  const second = snapshot.search("record-", first.nextCursor, 2) as any;
  assert.equal(first.matches.length, 2);
  assert.notEqual(first.matches[0].id, second.matches[0].id);
});

test("canonical projection governs edits, summaries and excluded shells", () => {
  const entries = [
    {
      type: "message",
      id: "a",
      parentId: null,
      message: { role: "user", content: "removed original" },
    },
    {
      type: "context_edit",
      id: "b",
      parentId: "a",
      targetId: "a",
      replacement: { content: "replacement" },
    },
    {
      type: "message",
      id: "c",
      parentId: "b",
      message: {
        role: "bashExecution",
        command: "excluded command",
        output: "hidden output",
        excludeFromContext: true,
      },
    },
    {
      type: "message",
      id: "d",
      parentId: "c",
      message: { role: "assistant", content: [{ type: "text", text: "omitted attempt" }] },
    },
    { type: "context_edit", id: "e", parentId: "d", targetId: "d", replacement: null },
    {
      type: "custom_message",
      id: "f",
      parentId: "e",
      customType: "context",
      content: "injected context",
      display: false,
    },
  ] as unknown as SessionEntry[];
  const snapshot = new SessionSnapshot(buildSessionProjection(entries).messages);
  assert.match(snapshot.reference(), /replacement|injected context/);
  assert.doesNotMatch(
    snapshot.reference(),
    /removed original|hidden output|excluded command|omitted attempt/,
  );
  const summaryText = "Earlier work summary " + "context ".repeat(4000) + "final decision";
  const summary = new SessionSnapshot(
    messages([
      { role: "system", content: "secret prompt" },
      { role: "compactionSummary", summary: summaryText },
      { role: "branchSummary", summary: "Branch summary" },
      { role: "user", content: "Continue from the summary." },
      { role: "custom", customType: "context", content: "on-demand context" },
    ]),
  );
  assert.ok(summary.outline().includes(summaryText));
  assert.ok(summary.outline().indexOf(summaryText) < summary.outline().indexOf("Continue from"));
  assert.match(summary.outline(), /\[context id=C1/);
  assert.doesNotMatch(summary.outline(), /on-demand context/);
  assert.equal(read(summary, "C1").records[0]!.text, "on-demand context");
  assert.match(summary.reference(), /Branch summary/);
  assert.doesNotMatch(summary.reference(), /secret prompt/);
});

test("pending calls, orphaned results and invalid retrieval requests remain explicit", () => {
  const snapshot = new SessionSnapshot(
    messages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "pending", name: "bash", arguments: { command: "pwd" } }],
      },
      { role: "toolResult", toolCallId: "orphan", toolName: "read", content: "standalone result" },
    ]),
  );
  assert.match(snapshot.outline(), /status=pending/);
  assert.match(read(snapshot, "T2").records[0]!.text!, /standalone result/);
  const invalidArgs: Parameters<typeof executeSnapshotTool>[1]["arguments"][] = [
    { ids: ["T1"], offset: -1 },
    { ids: ["../../secret"] },
    { ids: ["T1"], extra: true },
    { ids: [] },
    { ids: ["T1"], startId: "T1", endId: "T2" },
    { startId: "T1" },
    { endId: "T2" },
    { startId: "T2", endId: "T1" },
    { startId: "T1", endId: "T999" },
  ];
  for (const args of invalidArgs) {
    const result = executeSnapshotTool(snapshot, {
      type: "toolCall",
      id: "x",
      name: "read_session",
      arguments: args,
    });
    assert.equal(result.isError, true);
    assert.equal(result.toolCallId, "x");
  }
  snapshot.dispose();
  assert.ok(read(snapshot, "T1").records[0]!.error);
  assert.deepEqual((snapshot.search("pwd") as any).matches, []);
});

test("reused source call IDs pair pending calls with results in arrival order", () => {
  const snapshot = new SessionSnapshot(
    messages([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "reused", name: "read", arguments: { path: "first.ts" } },
          { type: "toolCall", id: "reused", name: "read", arguments: { path: "second.ts" } },
        ],
      },
      { role: "toolResult", toolCallId: "reused", toolName: "read", content: "FIRST_RESULT" },
      { role: "toolResult", toolCallId: "reused", toolName: "read", content: "SECOND_RESULT" },
    ]),
  );
  assert.match(read(snapshot, "T1").records[0]!.text!, /first.ts[\s\S]*FIRST_RESULT/);
  assert.doesNotMatch(read(snapshot, "T1").records[0]!.text!, /SECOND_RESULT/);
  assert.match(read(snapshot, "T2").records[0]!.text!, /second.ts[\s\S]*SECOND_RESULT/);
  assert.doesNotMatch(snapshot.outline(), /status=pending/);
});

test("all retrieval labels remain in the outline despite long later prose", () => {
  const snapshot = new SessionSnapshot(
    messages([
      { role: "user", content: "Find the deployment failure." },
      ...Array.from({ length: 100 }, (_, i) => ({
        role: "assistant",
        content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: {} }],
      })),
      ...Array.from({ length: 20 }, () => ({
        role: "assistant",
        content: [{ type: "text", text: "later discussion ".repeat(100) }],
      })),
    ]),
  );
  const outline = snapshot.outline();
  assert.match(outline, /Find the deployment failure/);
  for (let i = 1; i <= 100; i++) assert.ok(outline.includes(`[toolcall id=T${i} `));
});

test("search excerpts locate long blocks and batched reads return every body in full", () => {
  const first = "a".repeat(20000) + "needle-first-tail";
  const second = "needle-second-head" + "b".repeat(20000);
  const snapshot = new SessionSnapshot(
    messages([
      { role: "toolResult", toolCallId: "a", toolName: "read", content: first },
      { role: "toolResult", toolCallId: "b", toolName: "read", content: second },
    ]),
  );
  const matches = snapshot.search("needle") as { matches: { id: string; excerpt: string }[] };
  assert.deepEqual(
    matches.matches.map((match) => match.id),
    ["T1", "T2"],
  );
  assert.ok(matches.matches.every((match) => match.excerpt.length < 400));
  const result = executeSnapshotTool(snapshot, {
    type: "toolCall",
    id: "read",
    name: "read_session",
    arguments: { ids: ["T1", "T2"] },
  });
  assert.equal(result.isError, false);
  const records = JSON.parse((result.content[0] as { text: string }).text).records;
  assert.equal(records[0].text, `Tool: read\nCall ID: a\nResult:\n${first}`);
  assert.equal(records[1].text, `Tool: read\nCall ID: b\nResult:\n${second}`);
  assert.ok(records.every((record: object) => !("nextOffset" in record)));
});

test("inclusive range reads follow snapshot order across dialogue, thinking and tool blocks", () => {
  const snapshot = new SessionSnapshot(source(), { includeThinking: true });
  const result = executeSnapshotTool(snapshot, {
    type: "toolCall",
    id: "range",
    name: "read_session",
    arguments: { startId: "U1", endId: "T1" },
  });
  assert.equal(result.isError, false);
  const records = JSON.parse((result.content[0] as { text: string }).text).records;
  assert.deepEqual(
    records.map((record: { id: string }) => record.id),
    ["U1", "H1", "A1", "T1"],
  );
  for (const record of records) assert.deepEqual(record, read(snapshot, record.id).records[0]);
  assert.deepEqual(snapshot.readRange("A1", "A1"), snapshot.read(["A1"]));

  const excluded = new SessionSnapshot(source());
  assert.deepEqual(
    excluded.readRange("U1", "T1").records.map((record) => record.id),
    ["U1", "A1", "T1"],
  );
  assert.throws(() => excluded.readRange("H1", "T1"), /unavailable/);
});
