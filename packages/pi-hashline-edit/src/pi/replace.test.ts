/**
 * pi integration tests for the `replace` tool: literal replaceAll, regex with
 * capture groups, flags, the maxMatches guard, 0-match / invalid-pattern
 * failures (signaled by throwing — pi's failure contract), diff + fresh-anchor
 * return, and chaining a hashline `edit` on an anchor returned by `replace`.
 *
 * Failures are signaled by throwing (see edit-tool.ts); tests use assert.rejects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { makeReplaceTool } from "./replace-tool.ts";
import { makeEditOverride } from "./edit-tool.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hl-replace-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const call = (tool: any, params: any) => tool.execute("0", params, undefined, undefined);

/** Extract a `LINE#HASH` anchor for `line` from a result text block. */
function anchorLine(block: string, line: number) {
	const m = new RegExp(`^${line}#([0-9A-Z]+)│`, "m").exec(block);
	if (!m) throw new Error(`line ${line} anchor not found in block`);
	return { line, hash: m[1] };
}

const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };

// renderResult delegates to pi's renderDiff, which reads the global TUI theme
// singleton — initialize it once for this test process (watcher off by default).
initTheme();

test("replace literal: replaces all occurrences", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "foo bar foo baz foo\n");
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "foo", replace: "qux" });
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "qux bar qux baz qux\n");
		assert.match(r.content[0].text, /3 matches/);
	});
});

test("replace literal: $ in replacement stays literal (no expansion)", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "cost: $5 here\n");
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "$5", replace: "$10" });
		assert.equal(r.isError, undefined);
		// literal mode: "$10" inserted verbatim, NOT interpreted as group-10 + "0"
		assert.equal(await readFile(f, "utf-8"), "cost: $10 here\n");
	});
});

test("replace literal: case-insensitive via flags", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "Foo fOo FOO\n");
		await call(makeReplaceTool(dir), { path: "f.txt", find: "foo", replace: "x", flags: "i" });
		assert.equal(await readFile(f, "utf-8"), "x x x\n");
	});
});

test("replace regex: capture groups in replacement", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "name: alice\nname: bob\n");
		await call(makeReplaceTool(dir), {
			path: "f.txt",
			find: "name: (\\w+)",
			replace: "user: $1",
			regex: true,
		});
		assert.equal(await readFile(f, "utf-8"), "user: alice\nuser: bob\n");
	});
});

test("replace regex: multiline flag matches line-anchored pattern", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		// without `m`, ^a$ wouldn't match (a isn't at end of string); with `m` it does
		await call(makeReplaceTool(dir), { path: "f.txt", find: "^a$", replace: "A", regex: true, flags: "m" });
		assert.equal(await readFile(f, "utf-8"), "A\nb\nc\n");
	});
});

test("replace regex: dotall flag makes . match newlines", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\n");
		// a.b only matches across the newline with the `s` (dotall) flag
		await call(makeReplaceTool(dir), { path: "f.txt", find: "a.b", replace: "X", regex: true, flags: "s" });
		assert.equal(await readFile(f, "utf-8"), "X\n");
	});
});

test("replace: 0 matches throws", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "zzz", replace: "y" }),
			/no matches/,
		);
		assert.equal(await readFile(f, "utf-8"), "a\nb\n", "file untouched on 0-match failure");
	});
});

test("replace: empty find throws", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "", replace: "x" }),
			/`find` is empty/,
		);
	});
});

test("replace: maxMatches guard throws before writing", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a".repeat(20) + "\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "a", replace: "b", maxMatches: 5 }),
			/exceed `maxMatches`/,
		);
		assert.equal(await readFile(f, "utf-8"), "a".repeat(20) + "\n", "file untouched when guard trips");
	});
});

test("replace: invalid regex throws a friendly message", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "(unclosed", replace: "x", regex: true }),
			/invalid regex/,
		);
	});
});

test("replace: invalid flag char throws", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "f.txt"), "a\n");
		await assert.rejects(
			call(makeReplaceTool(dir), { path: "f.txt", find: "a", replace: "x", flags: "z" }),
			/invalid regex flag/,
		);
	});
});

test("replace: count-but-no-net-change does not rewrite and reports it", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "xx\n");
		// $& = whole match = "x", so the text is unchanged despite 2 matches
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "x", replace: "$&", regex: true });
		assert.equal(r.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "xx\n");
		assert.match(r.content[0].text, /no net change/);
	});
});

test("replace: returns details.diff (string) + patch + firstChangedLine", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "b", replace: "B" });
		assert.equal(typeof r.details.diff, "string");
		assert.equal(typeof r.details.patch, "string");
		assert.equal(typeof r.details.firstChangedLine, "number");
	});
});

test("replace: returns fresh anchors for the changed region", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "b", replace: "B" });
		const out: string = r.content[0].text;
		assert.match(out, /Updated anchors/);
		// line 2 now holds "B"; its anchor must be present and correct
		const a2 = anchorLine(out, 2);
		assert.ok(a2.hash.length >= 2);
	});
});

test("replace: changed-region anchor chains a subsequent hashline edit without a re-read", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "old old old\n");
		const replace = makeReplaceTool(dir);
		const r1: any = await call(replace, { path: "f.txt", find: "old", replace: "new" });
		const out: string = r1.content[0].text;
		// line 1 is the changed line; chain an edit on its returned anchor
		const a1 = anchorLine(out, 1);
		const edit = makeEditOverride(dir);
		const r2: any = await call(edit, {
			path: "f.txt",
			edits: [{ op: "replace", anchor: a1, body: ["NEW NEW NEW"] }],
		});
		assert.equal(r2.isError, undefined);
		assert.equal(await readFile(f, "utf-8"), "NEW NEW NEW\n");
	});
});

test("replace: multiline replacement (changes line count) still reports a correct span", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		// replace "b" with two lines → line count grows; changed region must cover the insertion
		const r: any = await call(makeReplaceTool(dir), { path: "f.txt", find: "b", replace: "B1\nB2" });
		assert.equal(await readFile(f, "utf-8"), "a\nB1\nB2\nc\n");
		const out: string = r.content[0].text;
		// the two inserted/changed lines (2 and 3) should both be anchored
		assert.doesNotThrow(() => anchorLine(out, 2));
		assert.doesNotThrow(() => anchorLine(out, 3));
	});
});

test("replace header: renderResult refreshes the call header in place — no invalidate", async () => {
	await withDir(async (dir) => {
		const f = join(dir, "f.txt");
		await writeFile(f, "a\nb\nc\n");
		const tool = makeReplaceTool(dir);
		const args = { path: "f.txt", find: "b", replace: "B1\nB2" };
		const r: any = await call(tool, args);
		let invalidated = false;
		const context: any = { args, isError: false, state: {}, invalidate: () => { invalidated = true; } };
		const header: any = tool.renderCall(args, stubTheme, context);
		assert.ok(!header.text.includes("+2"), "pre-execution header must not show counts");
		tool.renderResult({ content: r.content, details: r.details }, { isPartial: false, expanded: true }, stubTheme, context);
		assert.deepEqual(context.state.diffCounts, { added: 2, removed: 1 });
		assert.ok(header.text.includes("+2"), "header should show added count");
		assert.ok(header.text.includes("-1"), "header should show removed count");
		assert.ok(!invalidated, "renderResult must not call invalidate");
	});
});
