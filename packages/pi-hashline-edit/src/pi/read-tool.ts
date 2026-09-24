/**
 * Override read: text files output "lineNo#hash│content" by default; non-text (images /
 * binary) and read errors delegate to the built-in read.
 *
 * Hashes are computed from the current content on the fly — nothing is stored.
 * The hash is `(line number, content)`, recomputed and checked at edit time, so
 * no snapshot is needed to verify an anchor later.
 *
 * @module pi-hashline-edit/pi
 */

import {
	createReadTool,
	createReadToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	getLanguageFromPath,
	highlightCode,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { hashFileLines } from "../core/hash.ts";
import { hasFinalNewline, splitLines } from "../core/lines.ts";
import { getState } from "./state.ts";
import { Type } from "typebox";
import { serializeReadView, type ReadView } from "./output-view.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;
const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	anchored: Type.Optional(
		Type.Boolean({
			description:
				"Include LINE#HASH anchors in text output (default: true); set false for read-only content without edit anchors",
		}),
	),
});

function isTextBuffer(buf: Buffer): boolean {
	if (!isUtf8(buf)) return false;
	if (buf.subarray(0, 5).toString("ascii") === "%PDF-") return false;
	for (const byte of buf.subarray(0, 8192)) {
		if (byte < 7 || (byte >= 14 && byte < 32)) return false;
	}
	return true;
}

/**
 * Canonical absolute path: shared by read/edit/grep to resolve a file consistently.
 * Expands a leading `~` / `~/` to the user's home directory. (`~user` is not supported.)
 */
export function canonicalPath(cwd: string, p: string): string {
	return resolve(cwd, expandTilde(p));
}

/** Mirrors pi core's `normalizePath` tilde handling: expands `~` / `~/` (and `~\` on Windows), leaves `~user` untouched. */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
		return join(homedir(), p.slice(2));
	}
	return p;
}

/** Offset/limit range suffix for the read call line, e.g. `:50-99` (mirrors pi core's read tool). */
function formatReadLineRange(args: any, theme: any): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const start = args.offset ?? 1;
	const end = args.limit !== undefined ? start + args.limit - 1 : "";
	return theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
}

/** Render a structured read view for the TUI. */
function renderReadView(view: ReadView, theme: any): string {
	const out: string[] = [];
	const shownFrom = view.fromLine > 1 ? ` (from line ${view.fromLine})` : "";
	const noFinalNewline = view.noFinalNewline ? " · no trailing newline" : "";
	out.push(
		theme.fg("success", view.path) +
			theme.fg("dim", ` · ${view.totalLines} lines${shownFrom}${noFinalNewline}`),
	);
	const lineNos = view.rows.map((row) => String(row.lineNo));
	const detabbed = view.rows.map((row) => row.content.replace(/\t/g, "   "));
	const lang = getLanguageFromPath(view.path);
	let rendered: string[];
	if (lang) {
		const highlighted = highlightCode(detabbed.join("\n"), lang);
		rendered =
			highlighted.length === detabbed.length
				? highlighted
				: detabbed.map((line) => theme.fg("toolOutput", line));
	} else {
		rendered = detabbed.map((line) => theme.fg("toolOutput", line));
	}
	for (let i = 0; i < rendered.length; i++) {
		out.push(theme.fg("dim", `   ${lineNos[i]}: `) + rendered[i]);
	}
	for (const notice of view.displayNotices ?? view.notices) out.push(theme.fg("warning", notice));
	return out.join("\n");
}

/** Build the read override (a ToolDefinition fragment for registerTool). */
export function makeReadOverride(cwd: string) {
	const builtin = createReadTool(cwd);
	const builtinRenderer = createReadToolDefinition(cwd);
	if (!builtinRenderer.renderResult) throw new Error("Built-in read renderer is unavailable");
	const renderBuiltinResult = builtinRenderer.renderResult;
	const delegate = (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
	) => {
		const { anchored: _anchored, ...builtinParams } = params;
		return builtin.execute(toolCallId, builtinParams, signal, onUpdate);
	};

	return {
		name: "read" as const,
		label: "read",
		description:
			"Read file contents. Text files display per-line content hashes by default (LINE#HASH│content) for hashline-verified editing; set anchored:false for a read-only view without hashes.",
		promptSnippet:
			"Read files; each text line shows a content hash by default (LINE#HASH│content) anchoring it for edits",
		promptGuidelines: [
			'Text files display as `LINE#HASH│content` by default (e.g. `12#aF3│  return x`). Set `anchored:false` when you only need readable content; that view cannot provide edit anchors.',
			"Pass `path`; optionally `offset` (1-indexed start line), `limit` (max lines), and `anchored` (default true). Prefer read over cat/sed for files you intend to edit.",
		],
		parameters: readSchema,
		renderShell: "default" as const,

		renderCall(args: any, theme: any) {
			const pathDisplay = String(args?.path ?? "");
			let text = theme.fg("toolTitle", theme.bold("read")) + " " + theme.fg("accent", pathDisplay);
			const range = formatReadLineRange(args, theme);
			if (range) text += range;
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
			if (isPartial) return renderBuiltinResult(result, { isPartial, expanded }, theme, context);
			if (context?.isError) {
				return renderBuiltinResult(result, { isPartial, expanded }, theme, context);
			}
			const view = result.details?.hashlineView as ReadView | undefined;
			if (view?.kind === "read") {
				return new Text(expanded ? renderReadView(view, theme) : "", 0, 0);
			}
			return renderBuiltinResult(result, { isPartial, expanded }, theme, context);
		},

		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any) {
			// User cancelled → delegate to the built-in (builtin handles abort itself)
			if (signal?.aborted) return delegate(toolCallId, params, signal, onUpdate);

			const absPath = canonicalPath(cwd, params.path as string);
			let buf: Buffer;
			try {
				buf = await readFile(absPath);
			} catch {
				// read error → delegate to the built-in (it has polished error messages)
				return delegate(toolCallId, params, signal, onUpdate);
			}

			// Only confirmed text files enter hashline processing. Images and other
			// binary formats stay on the built-in read path for composability.
			const imageMime = await detectSupportedImageMimeTypeFromFile(absPath);
			if (imageMime || !isTextBuffer(buf)) return delegate(toolCallId, params, signal, onUpdate);

			const text = buf.toString("utf-8");
			const allLines = splitLines(text);
			const totalLines = allLines.length;
			const hashes = hashFileLines(allLines, getState().config.hashLen);

			// offset/limit
			const offset = (params.offset as number | undefined) ?? 1;
			const limit = (params.limit as number | undefined) ?? MAX_LINES;
			const startIdx = Math.max(0, offset - 1);
			const endIdx = Math.min(totalLines, startIdx + limit);

			// A file whose last line carries no terminator is a byte-level fact that the
			// numbered rows cannot show; state it in the header, the one line the model
			// never copies into an edit `body`.
			const candidate: ReadView = {
				version: 1,
				kind: "read",
				path: String(params.path),
				totalLines,
				fromLine: offset,
				noFinalNewline: !hasFinalNewline(text),
				rows: allLines.slice(startIdx, endIdx).map((content, index) => ({
					lineNo: startIdx + index + 1,
					content,
					hash: hashes[startIdx + index],
				})),
				notices: [],
			};
			const anchored = params.anchored !== false;
			const canonical = serializeReadView(candidate, anchored);
			const truncation = truncateHead(canonical, {
				maxBytes: MAX_BYTES,
				maxLines: Math.max(1, endIdx - startIdx) + 1,
			});
			const visibleCount = Math.max(0, Math.min(candidate.rows.length, truncation.outputLines - 1));
			const notices = truncation.truncated
				? [`… (truncated at ${MAX_BYTES >> 10}KB; use offset/limit to read more)`]
				: [];
			const view: ReadView = {
				...candidate,
				rows: candidate.rows.slice(0, visibleCount),
				notices,
				displayNotices: notices,
			};

			// Notices are part of the model view too; remove a final row if the notice
			// itself would push the response over the byte budget.
			while (
				view.rows.length > 0 &&
				Buffer.byteLength(serializeReadView(view, anchored), "utf-8") > MAX_BYTES
			) {
				view.rows = view.rows.slice(0, -1);
			}

			return {
				content: [{ type: "text" as const, text: serializeReadView(view, anchored) }],
				details: { hashlineView: view },
			};
		},
	};
}
