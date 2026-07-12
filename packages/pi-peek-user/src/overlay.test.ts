/**
 * Regression tests for local /peek follow-up context.
 * Run: node --test packages/pi-peek-user/src/overlay.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPeekHistoryMessages } from "./reference.ts";

test("empty peek history produces no prior chat messages", () => {
  assert.deepEqual(buildPeekHistoryMessages([]), []);
});

test("completed peek turns become real chat history for follow-up questions", () => {
  assert.deepEqual(
    buildPeekHistoryMessages([
      { role: "user", text: "Remember code ORANGE-731." },
      { role: "assistant", text: "收到。" },
    ]),
    [
      { role: "user", content: "Remember code ORANGE-731." },
      { role: "assistant", content: "收到。" },
    ],
  );
});
