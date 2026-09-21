/**
 * pi integration execute tests: drive the real makeReadOverride/makeEditOverride
 * execute, covering text read with anchors, the hashline edit round-trip,
 * chained edits via returned anchors, and error returns with isError.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool, initTheme } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import registerHashline from "../index.ts";
import { makeEditOverride } from "./edit-tool.ts";
import { makeReadOverride } from "./read-tool.ts";
import { getState } from "./state.ts";
import { computeLineHash } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hl-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const call = (tool: any, params: any) => tool.execute("0", params, undefined, undefined);

/** Anchor a model would copy from read output for `line` of `text` (1-based). */
function h(text: string, line: number) {
	return { line, hash: computeLineHash(line, splitLines(text)[line - 1]) };
}

/** Extract a `LINE#HASH` anchor from a read/edit result text block. */
function anchorLine(block: string, line: number) {
	const m = new RegExp(`^${line}#([0-9A-Z]+)│`, "m").exec(block);
	if (!m) throw new Error(`line ${line} anchor not found in block`);
	return { line, hash: m[1] };
}

test("read execute: text outputs LINE#HASH│content", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "line1\nline2\n");
		const r: any = await call(makeReadOverride(dir), { path: "f.txt" });
		const text = r.content[0];
		assert.equal(text.type, "text");
		assert.match(text.text, /1#[0-9A-Z]+│line1/);
		assert.match(text.text, /2#[0-9A-Z]+│line2/);
		assert.match(text.text, /f\.txt · 2 lines/);
	});
});

test("read execute: a missing final newline is stated in the header", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "line1\nline2");
		const bare: any = await call(makeReadOverride(dir), { path: "f.txt" });
		assert.match(bare.content[0].text, /f\.txt · 2 lines · no trailing newline/);

		await writeFile(join(dir, "g.txt"), "line1\nline2\n");
		const terminated: any = await call(makeReadOverride(dir), { path: "g.txt" });
		assert.doesNotMatch(terminated.content[0].text, /no trailing newline/);
	});
});

test("edit execute: a file without a final newline stays byte-exact", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		// The benchmark's literal-1-no-final-newline fixture: no terminator, plus a
		// word-joiner the model cannot see. Only line 2 may change; the missing
		// terminator must not turn into a new byte.
		const text = "guard\nold value\u2060";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 2), body: ["new value\u2060"] }],
		});
		assert.equal(r.isError, undefined, "should not be an error");
		assert.equal(await readFile(f, "utf-8"), "guard\nnew value\u2060");
	});
});

test("edit execute: hashline round-trip (read → edit → file changed)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 2), body: ["B"] }],
		});
		assert.equal(r.isError, undefined, "should not be an error");
		assert.equal(await readFile(f, "utf-8"), "a\nB\nc\n");
	});
});

test("edit execute: multiple ops in one call", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [
				{ op: "insert_after", anchor: h(text, 3), body: ["z"] },
				{ op: "replace", anchor: h(text, 1), body: ["A"] },
			],
		});
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "A\nb\nc\nz\n");
	});
});

test("edit result returns Updated anchors that chain the next edit without a re-read", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		const edit = makeEditOverride(dir);
		// first edit (model cites the read anchor for line 1)
		const r1: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 1), body: ["A"] }],
		});
		assert.equal(r1.isError, undefined);
		const out: string = r1.content[0].text;
		assert.match(out, /Updated anchors/);
		// second edit chains on the anchor returned by the first edit — no read in between
		const r2: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: anchorLine(out, 1), body: ["AA"] }],
		});
		assert.equal(r2.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "AA\nb\nc\n");
	});
});

test("edit result anchors cover an inserted block (chain an edit inside it)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\n";
		await writeFile(f, text);
		const edit = makeEditOverride(dir);
		const r1: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "insert_after", anchor: h(text, 2), body: ["c", "d", "e"] }],
		});
		assert.equal(r1.isError, undefined);
		const out: string = r1.content[0].text;
		// line 4 (d, one of the inserted lines) must be anchored in the result
		const a4 = anchorLine(out, 4);
		const r2: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: a4, body: ["DD"] }],
		});
		assert.equal(r2.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "a\nb\nc\nDD\ne\n");
	});
});

test("unrelated external change does NOT block an edit on a stable line", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		// simulate an external change at line 3 between read and edit
		await writeFile(f, "a\nb\nCHANGED\n");
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 1), body: ["A"] }],
		});
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "A\nb\nCHANGED\n");
	});
});

test("edit on a line that changed externally → anchor mismatch", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await writeFile(f, "a\nBCHANGED\nc\n"); // line 2 changed
		await assert.rejects(
			call(makeEditOverride(dir), {
				path: "f.txt",
				edits: [{ op: "replace", anchor: h(text, 2), body: ["x"] }],
			}),
			/anchor|re-read/i,
		);
	});
});

test("edit execute: no read before edit → anchor verification fails", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\nb\n");
		await assert.rejects(
			call(makeEditOverride(dir), {
				path: "f.txt",
				edits: [{ op: "replace", anchor: { line: 1, hash: "XXXX" }, body: ["A"] }],
			}),
			/anchor|re-read/i,
		);
	});
});

test("edit execute: empty edits → throws", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeEditOverride(dir), { path: "f.txt", edits: [] }),
			/empty|missing/i,
		);
	});
});

test("edit execute: malformed op (replace without body) → throws", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeEditOverride(dir), {
				path: "f.txt",
				edits: [{ op: "replace", anchor: { line: 1, hash: "XX" } }],
			}),
			/body/i,
		);
	});
});

test("edit schema: empty body rejected at the schema layer (minItems 1)", () => {
	const override: any = makeEditOverride("/tmp");
	for (const op of ["replace", "insert_after"] as const) {
		assert.throws(
			() => validateToolArguments(override, {
				name: "edit",
				arguments: { path: "f.txt", edits: [{ op, anchor: { line: 1, hash: "XX" }, body: [] }] },
			} as any),
			/Validation failed/,
		);
	}
});

test("edit execute: delete op", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "delete", anchor: h(text, 2) }],
		});
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "a\nc\n");
	});
});

test("disabled config registers no tools — built-ins remain", async () => {
	await withDir(async (dir) => {
		const oldCwd = process.cwd();
		const state = getState();
		const previous = state.config;
		try {
			await mkdir(join(dir, ".pi"));
			await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ hashlineEdit: { enabled: false } }));
			await writeFile(join(dir, "f.txt"), "old value\n");
			process.chdir(dir);
			const registered: string[] = [];
			registerHashline({ on() {}, registerTool(tool: { name: string }) { registered.push(tool.name); } } as any);
			assert.deepEqual(registered, []);
			const builtin = createEditTool(dir);
			const params = validateToolArguments(builtin, {
				name: "edit", arguments: { path: "f.txt", edits: [{ oldText: "old value", newText: "new value" }] },
			} as any);
			await call(builtin, params);
			assert.equal(await readFile(join(dir, "f.txt"), "utf-8"), "new value\n");
		} finally {
			process.chdir(oldCwd);
			state.config = previous;
		}
	});
});

// --- renderer regression guards (details.diff must be a string, renderResult must not throw) ---

const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };

// renderResult delegates to pi's renderDiff, which reads the global TUI theme
// singleton — initialize it once for this test process (watcher off by default).
initTheme();

test("edit success: details.diff is a string (not the generateDiffString object)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const r: any = await call(makeEditOverride(dir), {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 2), body: ["B"] }],
		});
		assert.equal(typeof r.details.diff, "string", "details.diff must be a string");
		assert.equal(typeof r.details.patch, "string");
		assert.equal(typeof r.details.firstChangedLine, "number");
	});
});

test("edit success: renderResult renders the diff without throwing", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\n";
		await writeFile(f, text);
		const edit = makeEditOverride(dir);
		const r: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: h(text, 2), body: ["B"] }],
		});
	// @ts-ignore — drive the renderer with a stub theme
		const comp: any = edit.renderResult({ content: r.content, details: r.details }, { isPartial: false, expanded: true }, stubTheme, { isError: r.isError ?? false, state: {}, invalidate: () => {} });
		assert.ok(typeof comp?.text === "string");
		assert.ok(comp.text.includes("B"), "rendered diff should contain the new content");
	});
});

test("edit header: renderResult refreshes the call header in place — no invalidate", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		const text = "a\nb\nc\nd\ne\n";
		await writeFile(f, text);
		await call(makeReadOverride(dir), { path: "f.txt" });
		const edit = makeEditOverride(dir);
		const r: any = await call(edit, {
			path: "f.txt",
			edits: [
				{ op: "replace", anchor: h(text, 2), end: h(text, 3), body: ["B"] },
				{ op: "insert_after", anchor: h(text, 5), body: ["f", "g"] },
			],
		});
		const args = { path: "f.txt", edits: [{ op: "replace" as const }] };
		let invalidated = false;
		const context: any = { args, isError: false, state: {}, invalidate: () => { invalidated = true; } };
		// first pass: renderCall builds the header; no counts exist yet
		const header: any = edit.renderCall(args, stubTheme, context);
		assert.ok(!header.text.includes("+3"), "pre-execution header must not show counts");
		// result lands: renderResult refreshes the SAME component in place
		edit.renderResult({ content: r.content, details: r.details }, { isPartial: false, expanded: true }, stubTheme, context);
		assert.deepEqual(context.state.diffCounts, { added: 3, removed: 2 });
		assert.ok(header.text.includes("+3"), "header should show added count");
		assert.ok(header.text.includes("-2"), "header should show removed count");
		// refreshing via context.invalidate() re-enters updateDisplay and renders
		// the diff twice — the renderer must never call it
		assert.ok(!invalidated, "renderResult must not call invalidate");
		// later full passes (expand/collapse) re-run renderCall; counts survive in state
		const header2: any = edit.renderCall(args, stubTheme, { args, state: context.state, lastComponent: header });
		assert.equal(header2, header, "renderCall reuses the stashed component");
		assert.ok(header2.text.includes("+3"), "re-render keeps the counts");
	});
});

test("edit error: renderResult renders the error line without throwing", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		const edit = makeEditOverride(dir);
		let thrown: any;
		await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: { line: 1, hash: "XXXX" }, body: ["A"] }],
		}).catch((e: any) => {
			thrown = e;
		});
		assert.ok(thrown, "expected the edit to throw");
		// @ts-ignore — simulate the framework handing the thrown message to renderResult
		const comp: any = edit.renderResult(
			{ content: [{ type: "text", text: thrown.message }] },
			{ isPartial: false, expanded: false },
			stubTheme,
			{ isError: true },
		);
		assert.ok(typeof comp?.text === "string");
	});
});

test("hash length stays 4 even for runs of identical lines (no explosion)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "\n\n\n\ncode\n");
		const r: any = await call(makeReadOverride(dir), { path: "f.txt" });
		const text: string = r.content[0].text;
		for (const m of text.matchAll(/\d+#([0-9A-Z]+)│/g)) {
			assert.equal(m[1].length, 4, `anchor ${m[0]} hash is not 4 chars`);
		}
	});
});
