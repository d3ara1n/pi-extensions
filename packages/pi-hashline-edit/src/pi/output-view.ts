/** Structured model/TUI views for hashline-aware read and grep output. */

export interface OutputRow {
  lineNo: number;
  /** Content retained for the TUI snapshot. */
  content: string;
  hash: string;
  /** Optional content projection sent to the model (for long grep lines). */
  modelContent?: string;
}

export interface ReadView {
  version: 1;
  kind: "read";
  path: string;
  totalLines: number;
  fromLine: number;
  noFinalNewline: boolean;
  rows: OutputRow[];
  notices: string[];
  displayNotices?: string[];
}

export type GrepViewLine =
  | { kind: "header"; path: string; matchCount: number }
  | { kind: "separator" }
  | { kind: "row"; row: OutputRow };

export interface GrepView {
  version: 1;
  kind: "grep";
  lines: GrepViewLine[];
  notices: string[];
  displayNotices?: string[];
}

export function serializeRow(row: OutputRow, anchored: boolean): string {
  const content = row.modelContent ?? row.content;
  return anchored ? `${row.lineNo}#${row.hash}│${content}` : `${row.lineNo}│${content}`;
}

export function serializeReadView(view: ReadView, anchored: boolean): string {
  const shownFrom = view.fromLine > 1 ? ` (from line ${view.fromLine})` : "";
  const noFinalNewline = view.noFinalNewline ? " · no trailing newline" : "";
  const header = `${view.path} · ${view.totalLines} lines${shownFrom}${noFinalNewline}`;
  const rows = view.rows.map((row) => serializeRow(row, anchored));
  const body = [header, ...rows];
  if (view.notices.length) body.push(...view.notices);
  return body.join("\n");
}

export function serializeGrepLine(line: GrepViewLine, anchored: boolean): string {
  switch (line.kind) {
    case "header":
      return `${line.path} · ${line.matchCount} match${line.matchCount !== 1 ? "es" : ""}`;
    case "separator":
      return "";
    case "row":
      return serializeRow(line.row, anchored);
  }
}

export function serializeGrepView(view: GrepView, anchored: boolean): string {
  const output = view.lines.map((line) => serializeGrepLine(line, anchored));
  if (view.notices.length) output.push("", `[${view.notices.join(". ")}]`);
  return output.join("\n");
}
