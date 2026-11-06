import { generateDiffString, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { FileChange } from "./apply.ts";
import { fileWarnings, formatNotices, type PatchNotice } from "./notices.ts";
import type { PatchRenderConfig } from "./config.ts";
import { cropDiff } from "./crop.ts";
import type { HunkMatchInfo } from "./core/types.ts";
import type { PreviewBlock } from "./stream-preview.ts";

export interface FileDetails {
  readonly kind: FileChange["kind"];
  readonly path: string;
  readonly moveTo?: string;
  readonly added?: number;
  readonly removed?: number;
  readonly diff?: string;
  readonly hunks?: readonly HunkMatchInfo[];
  /** The write replaced a file that already existed. */
  readonly overwrites?: boolean;
  /** Source content changed between verification and write. */
  readonly rematched?: boolean;
}
export interface PatchDetails {
  readonly files: readonly FileDetails[];
  readonly notices?: readonly PatchNotice[];
}

/**
 * What the one-line tool call header shows. Counts stay undefined until the
 * result supplies comparable diffs; a file whose previous content could not be
 * read has no diff, so the aggregate would be wrong and is omitted.
 *
 * @internal
 */
export interface PatchSummary {
  readonly fileCount: number;
  readonly added?: number;
  readonly removed?: number;
}

/** @internal */
export function makeDetails(
  files: readonly FileChange[],
  notices: readonly PatchNotice[] = files.flatMap(fileWarnings),
): PatchDetails {
  return {
    ...(notices.length ? { notices } : {}),
    files: files.map((file) => {
      const identity = { kind: file.kind, path: file.path, moveTo: file.moveTo };
      const annotations = {
        ...(file.hunks?.length ? { hunks: file.hunks } : {}),
        ...(file.overwrites ? { overwrites: true } : {}),
        ...(file.rematched ? { rematched: true } : {}),
      };
      if (file.before === undefined) return { ...identity, ...annotations };
      // Normalize display text only; filesystem content follows Codex's baseline.
      const display = (text: string) => text.replace(/\r\n?/g, "\n");
      const { diff } = generateDiffString(display(file.before), display(file.after));
      const lines = diff.split("\n");
      return {
        ...identity,
        ...annotations,
        added: lines.filter((line) => line.startsWith("+")).length,
        removed: lines.filter((line) => line.startsWith("-")).length,
        diff,
      };
    }),
  };
}

function safe(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Count `*** Add|Delete|Update File:` operations in raw patch text. @internal */
export function countPatchFiles(input: string): number {
  return [...input.matchAll(/^\s*\*\*\* (?:Add|Delete|Update) File: /gm)].length;
}

/** Aggregate per-file line counts into the header summary. @internal */
export function summarize(files: readonly FileDetails[]): PatchSummary {
  if (!files.every((file) => file.diff !== undefined)) return { fileCount: files.length };
  return {
    fileCount: files.length,
    added: files.reduce((total, file) => total + (file.added ?? 0), 0),
    removed: files.reduce((total, file) => total + (file.removed ?? 0), 0),
  };
}

/**
 * The single-line tool call header: tool name, file count, aggregate diff.
 *
 * @internal
 */
export function renderPatchHeader(theme: Theme, summary: PatchSummary): string {
  const counted = ` ${summary.fileCount} file${summary.fileCount === 1 ? "" : "s"}`;
  const stats =
    summary.added === undefined
      ? ""
      : ` ${theme.fg("toolDiffAdded", `+${summary.added}`)} ${theme.fg("toolDiffRemoved", `-${summary.removed ?? 0}`)}`;
  return theme.fg("toolTitle", theme.bold("apply_patch")) + theme.fg("dim", counted) + stats;
}

/** Render a preview block using the same text sanitization as completed results. @internal */
export function renderPreviewBlock(block: PreviewBlock, theme: Theme): string[] {
  const label = safe(block.moveTo ? `${block.path} → ${block.moveTo}` : block.path).replaceAll(
    "\n",
    " ",
  );
  const marker = { add: "A", update: "M", delete: "D" }[block.kind];
  const rows = [theme.fg("accent", `${marker} ${label}`)];
  if (block.state === "ready") {
    if (block.diff) rows.push(renderDiff(safe(block.diff)));
    return rows;
  }
  if (block.state === "skipped") {
    rows.push(theme.fg("dim", safe(block.warning ?? "No changes.")));
    return rows;
  }
  if (block.state === "partial") {
    for (const line of block.glimpse ?? []) {
      const color = line.startsWith("+")
        ? "toolDiffAdded"
        : line.startsWith("-")
          ? "toolDiffRemoved"
          : "dim";
      rows.push(theme.fg(color, safe(line)));
    }
    rows.push(theme.fg("dim", "… writing"));
    return rows;
  }
  if (block.state === "unmatched" || block.state === "invalid") {
    rows.push(theme.fg("warning", safe(block.warning ?? "Preview unavailable.")));
    return rows;
  }
  rows.push(theme.fg("dim", "Preview unavailable: file is outside the workspace or not readable."));
  return rows;
}

/** @internal */
export function renderPatchResult(
  details: PatchDetails | undefined,
  text: string,
  expanded: boolean,
  isError: boolean,
  theme: Theme,
  config: PatchRenderConfig,
): Text {
  if (isError || !Array.isArray(details?.files)) {
    const output = expanded
      ? text
      : [text.split("\n")[0], formatNotices(details?.notices ?? [])].filter(Boolean).join("\n\n");
    return new Text(theme.fg(isError ? "error" : "muted", safe(output)), 0, 0);
  }
  const files: readonly FileDetails[] = details.files;
  // The file count and aggregate diff live in the tool call header, so the body
  // carries only the per-file rows (and their diffs when expanded).
  const rows: string[] = [];
  const dim = (text: string) => theme.fg("dim", text);
  for (const file of expanded ? files : files.slice(0, 8)) {
    const marker = { add: "A", update: "M", delete: "D" }[file.kind];
    const path = safe(file.moveTo ? `${file.path} → ${file.moveTo}` : file.path).replaceAll(
      "\n",
      " ",
    );
    rows.push(theme.fg("accent", `${marker} ${path}`));
    if (file.diff === undefined)
      rows.push(dim("Diff unavailable: previous content could not be read."));
    if (file.diff) {
      // Delegate to pi's renderer: semantic diff colors plus word-level
      // highlighting on single-line modifications, matching the built-in edit
      // tool. The folded view crops each file to the configured context and
      // changed-line budget; the expanded view renders the diff whole.
      const diff = safe(file.diff);
      rows.push(renderDiff(expanded ? diff : cropDiff(diff, config)));
    }
  }
  if (!expanded && files.length > 8) rows.push(theme.fg("dim", `… ${files.length - 8} more files`));
  // Old history entries have per-file annotations but no unified notice list.
  const notices = details.notices ?? files.flatMap(fileWarnings);
  const noticeText = formatNotices(notices);
  if (noticeText) rows.push(theme.fg("warning", safe(noticeText)));
  return new Text(rows.join("\n"), 0, 0);
}
