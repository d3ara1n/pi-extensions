import { generateDiffString, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { FileChange } from "./apply.ts";

export interface FileDetails {
  readonly kind: FileChange["kind"];
  readonly path: string;
  readonly moveTo?: string;
  readonly added?: number;
  readonly removed?: number;
  readonly diff?: string;
}
export interface PatchDetails {
  readonly files: readonly FileDetails[];
}

/** @internal */
export function makeDetails(files: readonly FileChange[]): PatchDetails {
  return {
    files: files.map((file) => {
      const identity = { kind: file.kind, path: file.path, moveTo: file.moveTo };
      if (file.before === undefined) return identity;
      // Normalize display text only; filesystem content follows Codex's baseline.
      const display = (text: string) => text.replace(/\r\n?/g, "\n");
      const { diff } = generateDiffString(display(file.before), display(file.after));
      const lines = diff.split("\n");
      return {
        ...identity,
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

/** @internal */
export function renderPatchResult(
  details: PatchDetails | undefined,
  text: string,
  expanded: boolean,
  isError: boolean,
  theme: Theme,
): Text {
  if (isError || !Array.isArray(details?.files)) {
    const output = expanded ? text : text.split("\n")[0];
    return new Text(theme.fg(isError ? "error" : "muted", safe(output)), 0, 0);
  }
  const files: readonly FileDetails[] = details.files;
  const added = files.reduce((total, file) => total + (file.added ?? 0), 0);
  const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0);
  const counts = files.every((file) => file.diff !== undefined)
    ? ` ${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}`
    : "";
  const rows = [theme.fg("muted", `${files.length} file${files.length === 1 ? "" : "s"}`) + counts];
  for (const file of expanded ? files : files.slice(0, 8)) {
    const marker = { add: "A", update: "M", delete: "D" }[file.kind];
    const path = safe(file.moveTo ? `${file.path} → ${file.moveTo}` : file.path).replaceAll(
      "\n",
      " ",
    );
    rows.push(theme.fg("accent", `${marker} ${path}`));
    if (file.diff === undefined)
      rows.push(theme.fg("dim", "Diff unavailable: previous content could not be read."));
    if (expanded && file.diff) {
      const lines = safe(file.diff).split("\n");
      for (const line of lines.slice(0, 120)) {
        rows.push(
          theme.fg(
            line.startsWith("+")
              ? "toolDiffAdded"
              : line.startsWith("-")
                ? "toolDiffRemoved"
                : "toolDiffContext",
            line,
          ),
        );
      }
      if (lines.length > 120) rows.push(theme.fg("dim", `… ${lines.length - 120} more diff lines`));
    }
  }
  if (!expanded && files.length > 8) rows.push(theme.fg("dim", `… ${files.length - 8} more files`));
  return new Text(rows.join("\n"), 0, 0);
}
