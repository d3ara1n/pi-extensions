import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionSnapshot } from "./snapshot.ts";
import { executeSnapshotTool } from "./retrieval.ts";
import { estimateTextTokens } from "./budget.ts";

type Messages = ConstructorParameters<typeof SessionSnapshot>[0];
const messages = (value: unknown[]) => value as Messages;
const read = (snapshot: SessionSnapshot, id: string, offset = 0, limit = 12000) =>
  snapshot.read([id], offset, limit) as {
    records: { text?: string; error?: string; nextOffset?: number | null }[];
  };

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
  const outline = snapshot.outline(4000);
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
  assert.match(included.outline(4000), /\[thinking id=H1/);
  assert.doesNotMatch(included.outline(4000), /private rationale/);
  assert.match(read(included, "H1").records[0]!.text!, /private rationale/);
  assert.doesNotMatch(included.reference(), /redacted rationale|opaque signature/);
});

test("bounded outlines preserve references and allow paged recovery of omitted content", () => {
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
  const outline = snapshot.outline(1000);
  assert.ok(estimateTextTokens(outline) <= 1000);
  assert.match(outline, /omitted|abbreviated/);
  assert.doesNotMatch(outline, /TAIL-needle/);
  assert.match(JSON.stringify(snapshot.search("tail-NEEDLE")), /U1/);
  let recovered = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const page: ReturnType<typeof read>["records"][number] = read(snapshot, "U1", offset, 1000)
      .records[0]!;
    recovered += page.text;
    offset = page.nextOffset!;
  }
  assert.equal(recovered, body);
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
  const summary = new SessionSnapshot(
    messages([
      { role: "system", content: "secret prompt" },
      { role: "compactionSummary", summary: "Earlier work summary" },
      { role: "branchSummary", summary: "Branch summary" },
    ]),
  );
  assert.match(summary.outline(2000), /Earlier work summary/);
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
  assert.match(snapshot.outline(2000), /status=pending/);
  assert.match(read(snapshot, "T2").records[0]!.text!, /standalone result/);
  const invalidArgs: Parameters<typeof executeSnapshotTool>[1]["arguments"][] = [
    { ids: ["T1"], offset: -1 },
    { ids: ["../../secret"] },
    { ids: ["T1"], extra: true },
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
  assert.doesNotMatch(snapshot.outline(2000), /status=pending/);
});

test("a small outline retains the task anchor and a tool reference despite long later prose", () => {
  const snapshot = new SessionSnapshot(
    messages([
      { role: "user", content: "Find the deployment failure." },
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }] },
      ...Array.from({ length: 20 }, () => ({
        role: "assistant",
        content: [{ type: "text", text: "later discussion ".repeat(100) }],
      })),
    ]),
  );
  const outline = snapshot.outline(650);
  assert.ok(estimateTextTokens(outline) <= 650);
  assert.match(outline, /Find the deployment failure/);
  assert.match(outline, /\[toolcall id=T1/);
});

test("batched reads divide the shared budget without starving later records", () => {
  const snapshot = new SessionSnapshot(
    messages([
      { role: "user", content: "a".repeat(1000) },
      { role: "user", content: "b".repeat(1000) },
    ]),
  );
  const result = snapshot.read(["U1", "U2"], 0, 100) as {
    records: { text: string; nextOffset: number }[];
  };
  assert.equal(
    result.records.reduce((sum, page) => sum + page.text.length, 0),
    100,
  );
  assert.ok(result.records.every((page) => page.nextOffset > 0));
});
