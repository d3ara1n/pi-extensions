import type { FileChange } from "./apply.ts";
import type { PatchNotice } from "./core/types.ts";
export type { PatchNotice } from "./core/types.ts";

/** Collect execution facts without changing matching or write policy. @internal */
export function fileWarnings(
  file: Pick<FileChange, "path" | "moveTo" | "hunks" | "overwrites" | "rematched">,
): PatchNotice[] {
  const path = file.moveTo ?? file.path;
  const notices: PatchNotice[] = [];
  const warn = (code: string, message: string, hunk?: number, line?: number) =>
    notices.push({
      kind: "warning",
      code,
      path,
      message,
      ...(hunk !== undefined ? { hunk } : {}),
      ...(line !== undefined ? { line } : {}),
    });
  if (file.overwrites) warn("overwrite", `${path}: overwrote an existing file`);
  if (file.rematched)
    warn("rematched", `${path}: rematched against content that changed while queued`);
  for (const hunk of file.hunks ?? []) {
    const where = `${path} hunk ${hunk.hunk} at line ${hunk.line}`;
    if (hunk.occurrences > 1)
      warn(
        "repeated-context",
        `${where}: context occurs ${hunk.occurrences} times in the file; this occurrence was edited`,
        hunk.hunk,
        hunk.line,
      );
    if (hunk.strategy !== "exact") {
      const adjustment = {
        trim_end: "ignoring trailing whitespace",
        trim: "ignoring leading and trailing whitespace",
        unicode: "normalizing whitespace and Unicode punctuation",
      }[hunk.strategy];
      warn(
        "normalized-match",
        `${where}: matched only after ${adjustment}; check the indentation and characters of added lines`,
        hunk.hunk,
        hunk.line,
      );
    }
  }
  return notices;
}

/** Bounded text; details retain every structured notice. @internal */
export function formatNotices(notices: readonly PatchNotice[]): string {
  const sections: string[] = [];
  for (const kind of ["repair", "warning"] as const) {
    const selected = notices.filter((notice) => notice.kind === kind);
    if (!selected.length) continue;
    sections.push(
      kind === "repair" ? "Input repairs (the supplied patch was noncanonical):" : "Warnings:",
      ...selected.slice(0, 20).map((notice) => `- ${notice.message}`),
      ...(selected.length > 20 ? [`- … ${selected.length - 20} more ${kind} notices`] : []),
      "",
    );
  }
  return sections.join("\n").trimEnd();
}

/** Attach notices to an outcome without implying that repairs authorized a write. @internal */
export function withNotices(text: string, notices: readonly PatchNotice[]): string {
  const suffix = formatNotices(notices);
  return suffix ? `${text}\n\n${suffix}` : text;
}

/** Carries repairs even when parsing, verification, or writing subsequently fails. @internal */
export class PatchApplicationError extends Error {
  readonly notices: readonly PatchNotice[];
  constructor(error: unknown, notices: readonly PatchNotice[]) {
    super(withNotices(error instanceof Error ? error.message : String(error), notices), {
      cause: error,
    });
    this.name = "PatchApplicationError";
    this.notices = [...notices];
  }
}
