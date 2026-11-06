// Adapted from openai/codex apply-patch at b04a2c2645. See NOTICE.
import { BEGIN, END, MOVE, EOF, operationHeader } from "./syntax.ts";
import type { Chunk, FileOperation, ParsedPatch } from "./types.ts";

type MutableChunk = {
  anchor?: string;
  oldLines: string[];
  newLines: string[];
  newLineSources: (number | null)[];
  endOfFile: boolean;
};
type PendingOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: MutableChunk[]; line: number };

function invalidPatch(message: string): never {
  throw new Error(`invalid patch: ${message}`);
}
function invalidHunk(line: number, message: string): never {
  throw new Error(`invalid hunk at line ${line}, ${message}`);
}
function empty(chunk: Chunk): boolean {
  return chunk.oldLines.length === 0 && chunk.newLines.length === 0;
}
function unexpected(line: number, text: string): never {
  return invalidHunk(
    line,
    `Unexpected line found in update hunk: '${text}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
  );
}
function boundaries(lines: readonly string[]): void {
  if (lines[0] !== BEGIN) invalidPatch(`The first line of the patch must be '${BEGIN}'`);
  if (lines.at(-1) !== END) invalidPatch(`The last line of the patch must be '${END}'`);
}

/** Parse canonical single-workspace Codex patches; normalize input first. @internal */
export function parsePatch(input: string, sourceLines?: readonly number[]): ParsedPatch {
  const lines = input.split("\n");
  boundaries(lines);
  const operations: FileOperation[] = [];
  let current: PendingOperation | undefined;
  let ended = false;

  function finish(line: number, text: string): void {
    if (!current) return;
    if (current.kind === "update") {
      if (!current.chunks.length)
        invalidHunk(current.line, `Update file hunk for path '${current.path}' is empty`);
      if (empty(current.chunks.at(-1)!)) {
        if (text === END) invalidHunk(line, "Update hunk does not contain any lines");
        unexpected(line, text);
      }
      const { line: _line, ...operation } = current;
      operations.push(operation);
    } else {
      operations.push(current);
    }
    current = undefined;
  }

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    const number = sourceLines?.[index] ?? index + 1;
    const marker = line;
    if (ended) invalidPatch(`The last line of the patch must be '${END}'`);
    if (marker === END) {
      finish(number, marker);
      ended = true;
      continue;
    }
    const header = operationHeader(marker);
    if (header) {
      finish(number, marker);
      const [prefix, kind] = header;
      const path = marker.slice(prefix.length);
      current =
        kind === "add"
          ? { kind, path, content: "" }
          : kind === "delete"
            ? { kind, path }
            : { kind, path, chunks: [], line: number };
      continue;
    }
    if (!current && marker.startsWith("*** Environment ID:")) {
      invalidPatch(
        "Environment IDs are not supported; apply_patch operates in the current workspace.",
      );
    }
    if (current?.kind === "add" && line.startsWith("+")) {
      current.content += `${line.slice(1)}\n`;
      continue;
    }
    if (current?.kind !== "update") {
      invalidHunk(
        number,
        `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
      );
    }

    const last = current.chunks.at(-1);
    const isAnchor = marker === "@@" || marker.startsWith("@@ ");
    if (last?.endOfFile) {
      if (!isAnchor)
        invalidHunk(
          number,
          `Expected update hunk to start with a @@ context marker, got: '${line}'`,
        );
    }
    if (!current.chunks.length && current.moveTo === undefined && marker.startsWith(MOVE)) {
      current.moveTo = marker.slice(MOVE.length);
      continue;
    }
    if (isAnchor) {
      if (last && empty(last)) unexpected(number, line);
      current.chunks.push({
        anchor: marker === "@@" ? undefined : marker.slice(3),
        oldLines: [],
        newLines: [],
        newLineSources: [],
        endOfFile: false,
      });
      continue;
    }
    if (marker === EOF) {
      if (last && empty(last)) invalidHunk(number, "Update hunk does not contain any lines");
      if (last) last.endOfFile = true;
      continue;
    }
    const prefix = line[0];
    if (prefix === " " || prefix === "+" || prefix === "-") {
      if (!last) invalidHunk(number, "Expected update hunk to start with a @@ context marker");
      const chunk = last;
      const text = line.slice(1);
      if (prefix !== "+") chunk.oldLines.push(text);
      if (prefix !== "-") {
        chunk.newLines.push(text);
        chunk.newLineSources.push(prefix === "+" ? null : chunk.oldLines.length - 1);
      }
      continue;
    }
    if (last && !empty(last))
      invalidHunk(number, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
    unexpected(number, line);
  }
  if (!ended) invalidPatch(`The last line of the patch must be '${END}'`);
  return { operations };
}
