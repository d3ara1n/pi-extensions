import type { PatchNotice } from "./types.ts";
import { BEGIN, END, EOF, MOVE, operationHeader } from "./syntax.ts";
import { trim, trimEnd } from "./text.ts";

/** Canonical input and repair provenance shared by execution and preview. @internal */
export interface NormalizedPatch {
  readonly input: string;
  readonly notices: readonly PatchNotice[];
  /** Original 1-based input line for each canonical line, including inserted markers. */
  readonly sourceLines: readonly number[];
}

interface InputLine {
  text: string;
  source: number;
}

/** Update context prefixes stay literal except on the final patch boundary. */
function structuralMarker(line: string, inUpdate: boolean, finalLine: boolean): string {
  return inUpdate && !finalLine ? trimEnd(line) : trim(line);
}

/** Classify the complete EOF tail without guessing whether bare blanks are additions. */
function eofTailKind(
  lines: readonly InputLine[],
  start: number,
): "additions" | "padding" | "invalid" {
  let additions = false;
  let padding = false;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index].text;
    const marker = structuralMarker(line, true, index === lines.length - 1);
    if (line.startsWith("@@") || operationHeader(marker) || marker === END || marker === EOF) break;
    if (line.startsWith("+")) additions = true;
    else if (!marker) padding = true;
    else return "invalid";
    if (additions && padding) return "invalid";
  }
  return additions ? "additions" : "padding";
}

/**
 * Canonicalize deterministic format variations before strict parsing. Never read
 * source files, invent missing boundaries, or guess Update line prefixes.
 * Incomplete envelopes pass through unchanged for the parser to reject.
 * @internal
 */
export function normalizePatchInput(input: string): NormalizedPatch {
  let lines: InputLine[] = input.split(/\r?\n/).map((text, index) => ({
    text,
    source: index + 1,
  }));
  // Blank envelope lines and transport line endings are representation details.
  // Keep boundary-line padding until marker normalization so it is reported.
  let first = 0;
  let last = lines.length - 1;
  while (first < last && !trim(lines[first].text)) first++;
  while (last > first && !trim(lines[last].text)) last--;
  lines = lines.slice(first, last + 1);
  const notices: PatchNotice[] = [];
  const grouped = new Map<
    string,
    { code: string; path?: string; line: number; count: number; action: string }
  >();
  function repair(code: string, line: number, action: string, path?: string): void {
    const key = JSON.stringify([code, path]);
    const prior = grouped.get(key);
    if (prior) prior.count++;
    else grouped.set(key, { code, path, line, count: 1, action });
  }
  const complete = (candidate: readonly InputLine[]) =>
    trim(candidate[0]?.text ?? "") === BEGIN && trim(candidate.at(-1)?.text ?? "") === END;

  if (!complete(lines) && lines.length >= 4) {
    const first = lines[0].text.replace(/^\p{White_Space}+/u, "");
    const last = trimEnd(lines.at(-1)!.text);
    const fence = /^(`{3,}|~{3,})[^`~]*$/.exec(first);
    const isFence = fence && new RegExp(`^${fence[1][0]}{${fence[1].length},}$`).test(last);
    const isHeredoc = ["<<EOF", "<<'EOF'", '<<"EOF"'].includes(first) && last.endsWith("EOF");
    const inner = lines.slice(1, -1);
    if ((isFence || isHeredoc) && complete(inner)) {
      repair(
        isFence ? "markdown-wrapper" : "heredoc-wrapper",
        lines[0].source,
        isFence ? "removed the enclosing Markdown fence" : "removed the enclosing heredoc wrapper",
      );
      lines = inner;
    }
  }
  if (!complete(lines)) {
    return { input, notices: [], sourceLines: input.split(/\r?\n/).map((_, index) => index + 1) };
  }

  const output: InputLine[] = [];
  let current: { kind: "add" | "update" | "delete"; path: string } | undefined;
  let hasChunk = false;
  let chunkHasBody = false;
  let afterEof = false;
  let eofTail: "additions" | "padding" | "invalid" = "padding";
  let ended = false;
  for (let index = 0; index < lines.length; index++) {
    const entry = lines[index];
    const line = index < lines.length - 1 ? entry.text.replace(/\r$/, "") : entry.text;
    const marker = structuralMarker(line, current?.kind === "update", index === lines.length - 1);
    const emit = (text: string) => output.push({ text, source: entry.source });
    const canonicalMarker = (text: string) => {
      if (text !== line)
        repair(
          "marker-whitespace",
          entry.source,
          "removed structural marker padding",
          current?.path,
        );
      emit(text);
    };
    if (ended) {
      // Leave invalid trailing material for strict parsing, even if it resembles
      // another operation that could otherwise be repaired.
      emit(line);
      continue;
    }
    if (index === 0) {
      canonicalMarker(BEGIN);
      continue;
    }
    if (marker === END) {
      canonicalMarker(END);
      ended = true;
      if (
        index < lines.length - 1 &&
        trim(lines.at(-1)!.text) === END &&
        lines.slice(index + 1, -1).every((line) => trim(line.text) === "")
      ) {
        repair("duplicate-end", lines.at(-1)!.source, "removed the extra final End marker");
        break;
      }
      continue;
    }
    const header = operationHeader(marker);
    if (header) {
      const [prefix, kind] = header;
      current = { kind, path: marker.slice(prefix.length) };
      hasChunk = false;
      chunkHasBody = false;
      afterEof = false;
      // Only a truly empty Update with no Move is a no-op. An empty explicit
      // hunk or Move still fails, rather than losing its requested operation.
      if (kind === "update") {
        const next = lines[index + 1];
        const nextMarker =
          next && structuralMarker(next.text, true, index + 1 === lines.length - 1);
        if (nextMarker === END || (nextMarker !== undefined && operationHeader(nextMarker))) {
          repair(
            "empty-update",
            entry.source,
            "discarded an empty Update block; that block made no changes",
            current.path,
          );
          current = undefined;
          continue;
        }
      }
      canonicalMarker(marker);
      continue;
    }
    if (current?.kind === "add") {
      // Unknown or damaged control markers are not silently written as content.
      if (!line.startsWith("+") && !trim(line).startsWith("***")) {
        repair(
          "add-prefix",
          entry.source,
          "added the missing '+' prefix to Add File content",
          current.path,
        );
        emit(`+${line}`);
      } else emit(line);
      continue;
    }
    if (current?.kind !== "update") {
      emit(line);
      continue;
    }
    if (!hasChunk && marker.startsWith(MOVE)) {
      canonicalMarker(marker);
      continue;
    }
    if (line.startsWith("@@")) {
      let anchor = marker;
      if (anchor !== "@@" && !anchor.startsWith("@@ ")) {
        anchor = `@@ ${anchor.slice(2)}`;
        repair(
          "anchor-space",
          entry.source,
          "inserted the required space after '@@'",
          current.path,
        );
      }
      // Compose separator repair with numeric-header repair in this one pass.
      // Pure additions retain their locator rather than gaining append semantics.
      if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/.test(anchor)) {
        let hasOldContent = false;
        for (let next = index + 1; next < lines.length; next++) {
          const text = lines[next].text;
          const nextMarker = structuralMarker(text, true, next === lines.length - 1);
          if (
            text.startsWith("@@") ||
            operationHeader(nextMarker) ||
            nextMarker === END ||
            nextMarker === EOF
          )
            break;
          if (text === "" || text.startsWith(" ") || text.startsWith("-")) hasOldContent = true;
        }
        if (hasOldContent) {
          anchor = "@@";
          repair(
            "numeric-hunk",
            entry.source,
            "replaced a unified-diff numeric hunk header with '@@'; context and removed lines determine the location",
            current.path,
          );
        }
      }
      if (anchor === marker) canonicalMarker(anchor);
      else emit(anchor);
      hasChunk = true;
      chunkHasBody = false;
      afterEof = false;
      continue;
    }
    if (marker === EOF) {
      canonicalMarker(marker);
      afterEof = hasChunk;
      eofTail = eofTailKind(lines, index + 1);
      continue;
    }
    if (afterEof && chunkHasBody && eofTail === "additions" && line.startsWith("+")) {
      // Preserve the preceding hunk's EOF constraint; the new hunk only appends.
      repair(
        "eof-addition-hunk",
        entry.source,
        "inserted an omitted hunk marker before additions after End of File",
        current.path,
      );
      emit("@@");
      afterEof = false;
      chunkHasBody = false;
    }
    if (afterEof && !marker) {
      // Padding-only tails retain their old compatibility. In a mixed tail,
      // leave blanks intact so another normalization pass cannot enable repair.
      if (eofTail === "padding") {
        repair(
          "eof-padding",
          entry.source,
          "removed ignored blank padding after End of File",
          current.path,
        );
      } else emit(line);
      continue;
    }
    if (!afterEof && (line === "" || /^[ +\-]/.test(line))) {
      chunkHasBody = true;
      if (!hasChunk) {
        repair(
          "implicit-hunk",
          entry.source,
          "inserted the omitted first '@@' hunk marker",
          current.path,
        );
        emit("@@");
        hasChunk = true;
      }
      if (line === "") {
        repair(
          "blank-context",
          entry.source,
          "added the missing context prefix to a blank Update line",
          current.path,
        );
        emit(" ");
      } else emit(line);
      continue;
    }
    emit(line);
  }
  for (const item of grouped.values()) {
    const where = item.path ? `${item.path}, patch line ${item.line}` : `patch line ${item.line}`;
    notices.push({
      kind: "repair",
      code: item.code,
      ...(item.path !== undefined ? { path: item.path } : {}),
      line: item.line,
      count: item.count,
      message: `${where}: ${item.action}${item.count > 1 ? ` (${item.count} occurrences)` : ""}`,
    });
  }
  return {
    input: output.map((line) => line.text).join("\n"),
    notices,
    sourceLines: output.map((line) => line.source),
  };
}
