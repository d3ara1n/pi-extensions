/**
 * Streaming patch sections stay as raw glimpses until their next operation
 * marker arrives. Completed updates use the executor's parser and matcher.
 * Only closed sections are cached; the current glimpse is replaced each frame.
 */

import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parsePatch } from "./core/parser.ts";
import { applyReplacements, planUpdate } from "./core/update.ts";
import { within } from "./workspace.ts";

export interface PreviewBlock {
  readonly kind: "add" | "update" | "delete";
  readonly path: string;
  readonly moveTo?: string;
  readonly state: "ready" | "partial" | "unmatched" | "noread" | "invalid";
  readonly diff?: string;
  readonly glimpse?: readonly string[];
  readonly warning?: string;
}

export interface StreamPreviewState {
  input?: string;
  cached?: readonly PreviewBlock[];
  sections: Map<string, PreviewBlock>;
}

/** Synchronous read boundary for rendering; tests provide an in-memory implementation. @internal */
export interface PreviewFileSystem {
  realpath(path: string): string;
  isFile(path: string): boolean;
  readFile(path: string): string;
}

const nodePreviewFileSystem: PreviewFileSystem = {
  realpath: realpathSync,
  isFile: (path) => statSync(path).isFile(),
  readFile: (path) =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path)),
};

/** @internal */
export function emptyPreviewState(): StreamPreviewState {
  return { sections: new Map() };
}

interface RawSection {
  kind: PreviewBlock["kind"];
  path: string;
  moveTo?: string;
  header: string;
  lines: string[];
  closed: boolean;
}

/** Split operation boundaries without interpreting incomplete hunks. */
function parseSections(input: string): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection | undefined;
  let begun = false;
  for (const line of input.split("\n")) {
    const text = line.replace(/\r$/, "");
    if (!begun) {
      if (text.trim() === "*** Begin Patch") begun = true;
      continue;
    }
    const marker = current?.kind === "update" ? text.trimEnd() : text.trim();
    if (marker === "*** End Patch") {
      if (current) current.closed = true;
      break;
    }
    const op = matchOperation(marker);
    if (op) {
      if (current) current.closed = true;
      current = { ...op, header: text, lines: [], closed: false };
      sections.push(current);
      continue;
    }
    if (marker.startsWith("*** Move to: ") && current?.kind === "update") {
      current.moveTo = marker.slice("*** Move to: ".length);
    }
    if (current) current.lines.push(text);
  }
  return sections;
}

function matchOperation(line: string): { kind: RawSection["kind"]; path: string } | undefined {
  for (const [marker, kind] of [
    ["*** Add File: ", "add"],
    ["*** Update File: ", "update"],
    ["*** Delete File: ", "delete"],
  ] as const) {
    if (line.startsWith(marker)) return { kind, path: line.slice(marker.length) };
  }
  return undefined;
}

/** Apply the executor's path policy before reading; workspaceOnly keeps reads inside it. */
function readPreviewFile(
  cwd: string,
  path: string,
  fs: PreviewFileSystem,
  workspaceOnly = true,
): string | undefined {
  try {
    const directory = resolve(cwd);
    const root = fs.realpath(directory);
    const absolute = resolve(directory, path);
    if (workspaceOnly && !within(absolute, directory) && !within(absolute, root)) return undefined;
    const canonical = fs.realpath(absolute);
    if (
      canonical === root ||
      (workspaceOnly && !within(canonical, root)) ||
      !fs.isFile(canonical)
    )
      return undefined;
    return fs.readFile(canonical);
  } catch {
    return undefined;
  }
}

/** Normalize line endings for display only, like makeDetails does for results. */
function toDiff(before: string, after: string): string {
  const display = (text: string) => text.replace(/\r\n?/g, "\n");
  return generateDiffString(display(before), display(after)).diff;
}

function completedBlock(
  section: RawSection,
  patch: string,
  cwd: string,
  fs: PreviewFileSystem,
  workspaceOnly: boolean,
): PreviewBlock {
  const base = { kind: section.kind, path: section.path, moveTo: section.moveTo };
  let operation;
  try {
    operation = parsePatch(patch).operations[0];
  } catch {
    return { ...base, state: "invalid", warning: "Preview unavailable: invalid patch section." };
  }
  if (operation.kind === "add") {
    return { ...base, state: "ready", diff: toDiff("", operation.content) };
  }
  if (operation.kind === "delete") return { ...base, state: "ready" };

  const content = readPreviewFile(cwd, operation.path, fs, workspaceOnly);
  if (content === undefined) return { ...base, state: "noread" };
  const plan = planUpdate(content, operation.chunks);
  const unmatched = plan.outcomes.filter((outcome) => outcome.status === "unmatched").length;
  if (unmatched > 0) {
    return {
      ...base,
      state: "unmatched",
      warning: `${unmatched} hunk${unmatched === 1 ? "" : "s"} did not match the file; the preview may be off, trust the result`,
    };
  }
  return {
    ...base,
    state: "ready",
    diff: toDiff(content, applyReplacements(content, plan.replacements)),
  };
}

/** Build a preview, matching each newly closed section once per tool call. @internal */
export function buildPreview(
  input: string,
  cwd: string,
  state: StreamPreviewState,
  fs: PreviewFileSystem = nodePreviewFileSystem,
  workspaceOnly = true,
): readonly PreviewBlock[] {
  if (input === state.input && state.cached) return state.cached;
  const blocks: PreviewBlock[] = [];
  const sections = new Map<string, PreviewBlock>();
  for (const section of parseSections(input)) {
    if (!section.closed) {
      blocks.push({
        kind: section.kind,
        path: section.path,
        moveTo: section.moveTo,
        state: "partial",
        glimpse: section.lines,
      });
      continue;
    }
    const patch = ["*** Begin Patch", section.header, ...section.lines, "*** End Patch"].join("\n");
    const block =
      state.sections.get(patch) ?? completedBlock(section, patch, cwd, fs, workspaceOnly);
    sections.set(patch, block);
    blocks.push(block);
  }
  state.input = input;
  state.sections = sections;
  state.cached = blocks;
  return blocks;
}
