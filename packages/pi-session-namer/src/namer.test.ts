/**
 * Tests for side-agent session naming: output limits, name cleaning,
 * instruction placement, head+tail truncation, per-side budgets, and
 * turn windowing.
 * Run: node --test packages/pi-session-namer/src/namer.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSessionName } from "./namer.ts";
import type { SessionNamerConfig } from "./types.ts";

const BASE_CONFIG: SessionNamerConfig = { enabled: true, sideAgentRole: "utility", maxLength: 0 };

function fakeRolesApi(reply: string, capture?: { content?: string }) {
  return {
    async completeWithRole(
      _role: string,
      params: { messages: { content: string }[] },
    ) {
      if (capture) capture.content = params.messages[0].content;
      return { content: [{ type: "text", text: reply }] };
    },
  };
}

async function generatedName(maxLength: number): Promise<string> {
  const config: SessionNamerConfig = { ...BASE_CONFIG, maxLength };
  return generateSessionName(fakeRolesApi("A descriptive generated session title") as any, "utility", config, {
    turns: [{ user: "Name this session" }],
  });
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

test("session namer throws when there is nothing to name from", async () => {
  await assert.rejects(
    generateSessionName(fakeRolesApi("Title") as any, "utility", BASE_CONFIG, { turns: [] }),
    /no conversation turns/,
  );
  await assert.rejects(
    generateSessionName(fakeRolesApi("Title") as any, "utility", BASE_CONFIG, {
      turns: [{ user: "   " }],
    }),
    /no conversation turns/,
  );
});

test("session namer strips echoed XML wrapper tags", async () => {
  assert.equal(
    await generateSessionName(fakeRolesApi("<title>Fix login bug</title>") as any, "utility", BASE_CONFIG, {
      turns: [{ user: "Name this session" }],
    }),
    "Fix login bug",
  );
});

test("session namer strips nested XML wrapper tags", async () => {
  assert.equal(
    await generateSessionName(
      fakeRolesApi("<assistant_reply><title>Fix login bug</title></assistant_reply>") as any,
      "utility",
      BASE_CONFIG,
      { turns: [{ user: "Name this session" }] },
    ),
    "Fix login bug",
  );
});

test("session namer puts the naming instruction in the user turn", async () => {
  const capture: { content?: string } = {};
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", { ...BASE_CONFIG, maxLength: 50 }, {
    turns: [{ user: "Name this session" }],
  });
  const captured = capture.content!;

  // The direct instruction must precede the tagged excerpt, so weak models
  // read the tags as data instead of a request to answer.
  const tagIdx = captured.indexOf("<turn");
  assert.ok(tagIdx > 0, "instruction should precede the tagged excerpt");
  const head = captured.slice(0, tagIdx).toLowerCase();
  assert.ok(head.includes("name the coding session"));
  assert.ok(head.includes("max 50 characters"));
  assert.ok(head.includes("not a request to fulfill"));
});

test("session namer keeps wrapper tags closed when truncating long fields", async () => {
  const capture: { content?: string } = {};
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", BASE_CONFIG, {
    turns: [{ user: "x".repeat(5000), assistant: "y".repeat(5000) }],
  });
  const captured = capture.content!;

  for (const tag of ["user", "assistant"]) {
    const open = captured.indexOf(`<${tag}>`);
    const close = captured.indexOf(`</${tag}>`);
    assert.ok(open >= 0, `<${tag}> tag should be present`);
    assert.ok(close > open, `</${tag}> must follow <${tag}>`);
  }
  // Each field must respect its own budget, not the raw length.
  assert.ok(captured.length < 1500, `packed prompt should be small, got ${captured.length} chars`);
});

test("session namer keeps both ends of an over-budget field", async () => {
  const capture: { content?: string } = {};
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", BASE_CONFIG, {
    turns: [{ user: "HEADMARK" + "x".repeat(400) + "TAILMARK" }],
  });
  const captured = capture.content!;
  assert.ok(captured.includes("HEADMARK"), "head of the field should survive");
  assert.ok(captured.includes("TAILMARK"), "tail of the field should survive");
  assert.ok(captured.includes("…"), "middle should be elided with an ellipsis");
});

test("session namer gives assistant replies a larger budget than user prompts", async () => {
  const capture: { content?: string } = {};
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", BASE_CONFIG, {
    turns: [{ user: "x".repeat(300) + "PROMPT-END", assistant: "y".repeat(300) + "REPLY-END" }],
  });
  const captured = capture.content!;
  const userField = captured.slice(captured.indexOf("<user>\n") + 7, captured.indexOf("\n</user>"));
  const asstField = captured.slice(
    captured.indexOf("<assistant>\n") + 12,
    captured.indexOf("\n</assistant>"),
  );
  // The 309-char prompt is cut to its 200-char budget (head + ellipsis + tail)…
  assert.equal(userField.length, 200);
  // …but the equally long assistant reply fits whole within its 400-char budget.
  assert.equal(asstField.length, 309);
  assert.ok(asstField.endsWith("REPLY-END"));
});

test("session namer omits the assistant tag when a turn has no reply", async () => {
  const capture: { content?: string } = {};
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", BASE_CONFIG, {
    turns: [{ user: "just a prompt" }],
  });
  assert.ok(capture.content!.includes("<user>"));
  assert.ok(!capture.content!.includes("<assistant>"));
});

test("session namer packs all turns when within the window limit", async () => {
  const capture: { content?: string } = {};
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", BASE_CONFIG, {
    turns: Array.from({ length: 8 }, (_, i) => ({ user: `prompt ${i + 1}` })),
  });
  const captured = capture.content!;

  for (let i = 1; i <= 8; i++) {
    assert.ok(captured.includes(`index="${i}"`), `turn ${i} should be packed`);
  }
  assert.ok(!captured.includes("turns omitted"), "no omission marker under the limit");
});

test("session namer windows to first and last turns when over the limit", async () => {
  const capture: { content?: string } = {};
  const turns = Array.from({ length: 12 }, (_, i) => ({ user: `prompt ${i + 1}` }));
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", BASE_CONFIG, { turns });
  const captured = capture.content!;

  // First 4 and last 4 kept, with original 1-based indexes.
  for (const i of [1, 2, 3, 4, 9, 10, 11, 12]) {
    assert.ok(captured.includes(`index="${i}"`), `turn ${i} should be kept`);
  }
  // Middle turns elided with a marker between the windows.
  for (const i of [5, 6, 7, 8]) {
    assert.ok(!captured.includes(`index="${i}"`), `turn ${i} should be elided`);
  }
  assert.ok(captured.includes("(4 turns omitted)"), "omission marker should be present");
  // Marker must sit between the two windows.
  const lastFirstWindow = captured.indexOf('index="4"');
  const marker = captured.indexOf("(4 turns omitted)");
  const firstLastWindow = captured.indexOf('index="9"');
  assert.ok(lastFirstWindow < marker && marker < firstLastWindow);
});
