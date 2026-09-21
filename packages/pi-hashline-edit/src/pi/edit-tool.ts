/**
 * Override edit: hashline ops via structured `edits` (LINE#HASH anchors).
 *
 * Each op in `edits` references line anchors copied from read / grep / replace output
 * (or from a prior edit's "Updated anchors"). The core verifies each anchor live against
 * the current file content — no snapshot, no global stale check: a cited line
 * that changed (or was misremembered) fails its own anchor; unchanged lines
 * elsewhere never block the edit. Legacy oldText/newText is not accepted — the
 * schema requires an `op` discriminator, so legacy payloads are rejected at the
 * schema layer (a visible failure, never a silent degradation).
 *
 * On success the result carries fresh `LINE#HASH` anchors for the lines this
 * edit produced (and the line that shifted into a deletion gap), so the model
 * can chain edits without a re-read.
 *
 * Concurrency safety: read-modify-write is wrapped in withFileMutationQueue.
 * AbortSignal is honored — checked after read / before write.
 *
 * @module pi-hashline-edit/pi
 */

import { generateDiffString, generateUnifiedPatch, withFileMutationQueue, type EditToolDetails } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, hashFileLines } from "../core/index.ts";
import { splitLines } from "../core/lines.ts";
import type { ApplyFailure, Edit } from "../core/types.ts";
import { canonicalPath } from "./read-tool.ts";
import { getState } from "./state.ts";
import { formatDiffCounts, publishDiffCounts, renderDiffPreview, type DiffCounts } from "./render.ts";

/** Cap on the number of updated anchors returned inline (bounds token cost for large inserts). */
const MAX_ANCHOR_LINES = 40;

/** `{line, hash}` anchor pair as an op field, described per use. */
function anchorRef(description: string) {
	return Type.Optional(
		Type.Object(
			{
				line: Type.Number({ description: "1-based line number" }),
				hash: Type.String({ description: "Line content hash copied from read output (the #HASH after the line number)" }),
			},
			{ description },
		),
	);
}

const editOpSchema = Type.Object({
	op: Type.Union(
		[
			Type.Literal("replace", { description: "Replace the cited line(s) with `body`." }),
			Type.Literal("delete", { description: "Delete the cited line(s)." }),
			Type.Literal("insert_after", {
				description: "Insert `body` immediately after the anchor line — the anchor line is kept as-is; do NOT copy it into `body`.",
			}),
			Type.Literal("insert_before", {
				description: "Insert `body` immediately before the anchor line — the anchor line is kept as-is; do NOT copy it into `body`.",
			}),
			Type.Literal("append", { description: "Append `body` at the end of the file." }),
			Type.Literal("prepend", { description: "Prepend `body` at the start of the file." }),
		],
		{ description: "Operation kind" },
	),
	anchor: anchorRef(
		"First line of the range (replace/delete) or the insertion point (insert_after/insert_before).",
	),
	end: anchorRef(
		"Last line of the range to replace/delete, inclusive: the op touches exactly [anchor..end]. Omit only for a single-line change (end == anchor). A multi-line change that forgets `end` succeeds silently with the rest of the intended range left in the file — a corrupted file, not an error.",
	),
	body: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "New content lines (non-empty; required for replace/insert/append/prepend; omit for delete)" })),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(editOpSchema, { description: "Hashline ops, each referencing LINE#HASH anchors from your latest read or edit result" }),
});

type EditOpInput = Static<typeof editOpSchema>;

/**
 * Turn an ApplyFailure into LLM-facing text. The FIRST line is a terse summary
 * (the TUI's renderResult shows only the first line of an error result); the
 * remaining lines carry the structured detail the model needs to retry without a
 * re-read — rescued anchors / ambiguous candidates / the cited line's live
 * content. range/noop are already terse single-line messages.
 */
function formatFailure(failure: ApplyFailure, path: string): string {
	if (failure.kind === "range") return failure.message;
	if (failure.kind === "noop") return failure.message;

	const lines: string[] = [];
	let found = 0;
	let ambiguous = 0;
	let none = 0;
	for (const f of failure.failures) {
		const where = `op #${f.opIndex} ${f.op} ${f.which} (line ${f.cited.line})`;
		switch (f.recovery.kind) {
			case "found": {
				found++;
				lines.push(
					`• ${where}: content shifted to line ${f.recovery.newLine}. Resend this op with ${f.which} { "line": ${f.recovery.newLine}, "hash": "${f.recovery.newHash}" }.`,
				);
				break;
			}
			case "ambiguous": {
				ambiguous++;
				const nums = f.recovery.candidates.map((c) => c.line).join(", ");
				const list = f.recovery.candidates
					.map((c) => `{ "line": ${c.line}, "hash": "${c.hash}" }`)
					.join(" / ");
				lines.push(
					`• ${where}: ambiguous — same content at lines ${nums}. Pick the right one and resend ${f.which} ${list}.`,
				);
				break;
			}
			case "none": {
				none++;
				const cur =
					f.current != null
						? `current line ${f.cited.line}: ${f.cited.line}#${f.current.hash}│${f.current.content}`
						: `line ${f.cited.line} is out of range`;
				lines.push(`• ${where}: not found nearby — content changed. ${cur}. Re-read ${path} for fresh anchors.`);
				break;
			}
		}
	}
	const parts: string[] = [];
	if (found) parts.push(`${found} rescued`);
	if (ambiguous) parts.push(`${ambiguous} ambiguous`);
	if (none) parts.push(`${none} need re-read`);
	const brief = `Anchor mismatch: ${parts.join(", ")}.`;
	return `${brief}\n${lines.join("\n")}`;
}

/** Translate JSON edit ops into core Edit[]. Validates conditional required fields (anchor/body per op). */
function toCoreEdits(ops: readonly EditOpInput[]): { ok: true; edits: Edit[] } | { ok: false; error: string } {
	const edits: Edit[] = [];
	for (const o of ops) {
		switch (o.op) {
			case "replace":
				if (!o.anchor) return { ok: false, error: "replace needs `anchor` {line, hash}" };
				if (!o.body) return { ok: false, error: "replace needs `body`" };
				edits.push({ op: "replace", start: o.anchor, end: o.end, body: o.body });
				break;
			case "delete":
				if (!o.anchor) return { ok: false, error: "delete needs `anchor` {line, hash}" };
				edits.push({ op: "delete", start: o.anchor, end: o.end });
				break;
			case "insert_after":
			case "insert_before":
				if (!o.anchor) return { ok: false, error: `${o.op} needs \`anchor\` {line, hash}` };
				if (!o.body) return { ok: false, error: `${o.op} needs \`body\`` };
				edits.push({ op: o.op, anchor: o.anchor, body: o.body });
				break;
			case "append":
			case "prepend":
				if (!o.body) return { ok: false, error: `${o.op} needs \`body\`` };
				edits.push({ op: o.op, body: o.body });
				break;
		}
	}
	return { ok: true, edits };
}

/**
 * Fail the edit by throwing. pi's contract: a tool failure is signaled by throwing,
 * not by returning `{ isError: true }` — the framework derives `context.isError` from
 * whether execute threw, and overwrites `result.isError` with it
 * (`updateResult({ ...result, isError: event.isError })`). Returning an isError object
 * left the TUI rendering failures as success (green). The thrown message reaches the
 * LLM verbatim; renderResult shows its first line in red.
 */
function errResult(text: string): never {
	throw new Error(text);
}

/**
 * Format the updated anchors (fresh LINE#HASH│content) for the touched new-file
 * lines, so the model can chain edits without a re-read. Capped to bound tokens.
 */
function formatUpdatedAnchors(newText: string, touched: readonly number[], hashLen: number): string {
	const newLines = splitLines(newText);
	const newHashes = hashFileLines(newLines, hashLen);
	const idxs = [...new Set(touched)].sort((a, b) => a - b);
	if (idxs.length === 0) return "";
	const rows = idxs.map((i) => `${i + 1}#${newHashes[i]}│${newLines[i]}`);
	const shown = rows.length > MAX_ANCHOR_LINES ? rows.slice(0, MAX_ANCHOR_LINES) : rows;
	const more = rows.length > MAX_ANCHOR_LINES ? `\n… (${rows.length - MAX_ANCHOR_LINES} more; re-read for full anchors)` : "";
	return `\nUpdated anchors (use these for the next edit):\n${shown.join("\n")}${more}`;
}

/** Call-header line: `edit path — N ops: op`, plus `+N -N` once the result's diff counts are known. */
function editHeader(args: Static<typeof editSchema>, theme: any, counts?: DiffCounts): string {
	let t = theme.fg("toolTitle", theme.bold("edit "));
	t += theme.fg("accent", args.path);
	const n = args.edits?.length ?? 0;
	if (n) t += theme.fg("dim", ` — ${n} op${n > 1 ? "s" : ""}: ${args.edits[0].op}`);
	if (counts && (counts.added || counts.removed)) t += formatDiffCounts(counts, theme);
	return t;
}

export function makeEditOverride(cwd: string) {

	return {
		name: "edit" as const,
		label: "edit",
		description:
		"Edit a file via hashline ops (LINE#HASH anchors, content-verified). Each op in `edits` references line anchors from your latest read, grep, replace, or edit result.",
		promptSnippet: "Edit files via hashline ops (edits[] with LINE#HASH anchors from read)",
		promptGuidelines: [
			"Pass `edits`: an array of ops. Each op = {op, anchor?, end?, body?}.",
		"Prefer one `edit` with multiple ops for several changes to the same file, rather than several separate `edit` calls.",
			"op ∈ replace | delete | insert_after | insert_before | append | prepend.",
		"anchor & end = {line, hash} copied from your latest read, grep, replace, or edit result (the `#HASH` after each line number); grep's `-C` context lines are anchored and editable too. replace/delete take anchor (+ optional end for a range); insert_after/insert_before take anchor; append/prepend take neither.",
			"body = non-empty string[] of new content lines (required for replace/insert/append/prepend; omit for delete).",
			"A successful edit returns `Updated anchors` for the changed lines — use those (not stale line numbers) for the next edit to the same file; re-read only if you need lines outside that set.",
		],
		parameters: editSchema,
		renderShell: "default" as const,

		renderCall(args: Static<typeof editSchema>, theme: any, context: any) {
			const text = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			// Stash the header for renderResult: the diff counts land after
			// execution and are refreshed in place (renderResult's lastComponent
			// is the result component, not this header)
			if (context?.state) context.state.callText = text;
			text.setText(editHeader(args, theme, context?.state?.diffCounts));
			return text;
		},

		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			if (isPartial) return new Text(theme.fg("warning", "Editing…"), 0, 0);
			const content = result.content?.[0];
			if (context.isError) {
				const t = content?.type === "text" ? content.text.split("\n")[0] : "Error";
				return new Text(theme.fg("error", t), 0, 0);
			}
			const diff: string | undefined = result.details?.diff;
			// refresh the call header's +N -N in place — never invalidate from
			// inside a renderer (re-enters updateDisplay, diff renders twice)
			publishDiffCounts(diff, context, (counts) => {
				context.state?.callText?.setText(editHeader(context.args, theme, counts));
			});
			if (!diff) {
				// No net diff (e.g. a successful but non-mutating edit): show only the summary
				// line — content.text also carries `Updated anchors` (hashline) for the model.
				const t = content?.type === "text" ? content.text.split("\n")[0] : "Edited";
				return new Text(theme.fg("success", t), 0, 0);
			}
			// details.diff is pi-format (+N/-N/<space>N content); renderDiff handles
			// semantic colors plus intra-line change highlighting
			return new Text(renderDiffPreview(diff, expanded, theme), 0, 0);
		},

		async execute(toolCallId: string, params: Static<typeof editSchema>, signal: AbortSignal | undefined, onUpdate: any) {
			const path = params.path;
			const absPath = canonicalPath(cwd, path);

			if (!params.edits?.length) {
				return errResult(`Edit ${path}: \`edits\` is empty or missing.`);
			}
			// withFileMutationQueue serializes read-modify-write for the same file, preventing parallel-edit data loss
			return await withFileMutationQueue(absPath, () => runHashline(absPath, path, params.edits, signal));
		},
	};
}

async function runHashline(absPath: string, displayPath: string, editOps: readonly EditOpInput[], signal: AbortSignal | undefined) {
	const { hashLen, shiftRadius } = getState().config;

	let currentText: string;
	try {
		currentText = (await readFile(absPath)).toString("utf-8");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return errResult(`Error reading ${displayPath}: ${msg}`);
	}
	// Check for cancel after read: if the user aborted, don't proceed to parse/apply; the file stays untouched
	if (signal?.aborted) return errResult(`Edit ${displayPath} aborted before apply.`);

	const translated = toCoreEdits(editOps);
	if (!translated.ok) return errResult(translated.error);

	// Anchors are verified against the current content. A line that changed (or a
	// hash the model didn't actually read) fails its own anchor — but first we try
	// shifted recovery: if the content merely moved within ±shiftRadius, a fresh
	// anchor is returned so the model can retry without a re-read. All failures in
	// the batch are collected (nothing written on any failure).
	const result = applyEdits(currentText, translated.edits, hashLen, shiftRadius);
	if (!result.ok) {
		return errResult(formatFailure(result.failure, displayPath));
	}

	// Check for cancel before write: if aborted, don't touch the disk; the file stays untouched
	if (signal?.aborted) return errResult(`Edit ${displayPath} aborted before write.`);

	try {
		await writeFile(absPath, result.text);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return errResult(`Error writing ${displayPath}: ${msg}`);
	}

	// generateDiffString / generateUnifiedPatch split on \n, so raw CRLF content would
	// leave a trailing \r on every diff line — the TUI line-wrapper (wrapTextWithAnsi)
	// then emits a spurious blank line per diff line. Normalize to LF for diff/patch
	// only; the disk write above already preserved the original line endings.
	const oldLf = currentText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const newLf = result.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const { diff, firstChangedLine } = generateDiffString(oldLf, newLf);
	const details: EditToolDetails = {
		diff,
		patch: generateUnifiedPatch(displayPath, oldLf, newLf),
		firstChangedLine,
	};
	const anchors = formatUpdatedAnchors(result.text, result.touchedLines, hashLen);
	return {
		content: [{ type: "text" as const, text: `Edited ${displayPath} (${translated.edits.length} op(s)).${anchors}` }],
		details,
	};
}
