/**
 * Tests for the short-circuit layer.
 * Run: node --test packages/pi-scout/src/short-circuit.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	normalizeAckPrompt,
	buildAckSet,
	evaluateShortCircuit,
} from "./short-circuit.ts";
import type { ShortCircuitConfig } from "./types.ts";

const CFG = (overrides: Partial<ShortCircuitConfig> = {}): ShortCircuitConfig => ({
	trivialAck: true,
	maxAckLength: 12,
	ackPhrases: [],
	...overrides,
});

// ── normalizeAckPrompt ─────────────────────────────────────────

test("normalizeAckPrompt strips trailing CJK/Latin punctuation", () => {
	assert.equal(normalizeAckPrompt("好的。"), "好的");
	assert.equal(normalizeAckPrompt("OK!"), "ok");
	assert.equal(normalizeAckPrompt("  嗯  "), "嗯");
	assert.equal(normalizeAckPrompt("はい。"), "はい");
	assert.equal(normalizeAckPrompt("네!"), "네");
});

test("normalizeAckPrompt preserves internal punctuation", () => {
	assert.equal(normalizeAckPrompt("好的，那我们继续"), "好的，那我们继续");
});

test("normalizeAckPrompt lowercases", () => {
	assert.equal(normalizeAckPrompt("OK"), "ok");
	assert.equal(normalizeAckPrompt("Sure"), "sure");
});

test("normalizeAckPrompt empty for pure punctuation", () => {
	assert.equal(normalizeAckPrompt("。。。"), "");
	assert.equal(normalizeAckPrompt("   "), "");
});

// ── buildAckSet ────────────────────────────────────────────────

test("buildAckSet includes defaults and user extras, normalized+deduped", () => {
	const set = buildAckSet(["收到啦", "OK", "  custom  "]);
	assert.ok(set.has("好的"));
	assert.ok(set.has("ok"));
	assert.ok(set.has("はい"));
	assert.ok(set.has("네"));
	assert.ok(set.has("收到啦"));
	assert.ok(set.has("custom"));
});

test("buildAckSet ignores empty normalized entries", () => {
	const set = buildAckSet(["。。。", ""]);
	assert.equal(set.size > 0, true);
	assert.ok(!set.has(""));
});

// ── evaluateShortCircuit ───────────────────────────────────────

test("trivial ack short-circuits across 中/英/日/韓", () => {
	const cfg = CFG();
	for (const prompt of ["好的", "ok", "はい", "네", "嗯嗯", "sure", "了解"]) {
		const r = evaluateShortCircuit(prompt, cfg);
		assert.ok(r, `expected short-circuit for: ${prompt}`);
		assert.equal(r!.reasoning, "trivial ack");
	}
});

test("trivial ack tolerates trailing punctuation", () => {
	const r = evaluateShortCircuit("好的。", CFG());
	assert.ok(r);
	assert.equal(r!.reasoning, "trivial ack");
});

test("long prompt starting with ack is NOT short-circuited", () => {
	const r = evaluateShortCircuit("好的，那我们重构整个模块吧", CFG());
	assert.equal(r, null);
});

test("prompt longer than maxAckLength is not an ack", () => {
	assert.equal(
		evaluateShortCircuit("understood thank you", CFG({ maxAckLength: 5 })),
		null,
	);
});

test("trivialAck disabled → ack falls through to model", () => {
	const r = evaluateShortCircuit("好的", CFG({ trivialAck: false }));
	assert.equal(r, null);
});

test("user ackPhrases extend the table", () => {
	const r = evaluateShortCircuit("收到啦", CFG({ ackPhrases: ["收到啦"] }));
	assert.ok(r);
	assert.equal(r!.reasoning, "trivial ack");
});

test("empty / punctuation-only prompt is not an ack", () => {
	assert.equal(evaluateShortCircuit("", CFG()), null);
	assert.equal(evaluateShortCircuit("。。。", CFG()), null);
});

test("ordinary prompt falls through to model", () => {
	assert.equal(
		evaluateShortCircuit("帮我看看这个函数有没有性能问题", CFG()),
		null,
	);
	assert.equal(
		evaluateShortCircuit("what is the weather today", CFG()),
		null,
	);
});
