interface SourceLine {
  readonly text: string;
  readonly ending: string;
}

/** Source text and its formatting metadata, kept separate from patch text. @internal */
export function splitSource(original: string): {
  bom: string;
  lines: SourceLine[];
  defaultEnding: string;
} {
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = original.slice(bom.length);
  const lines: SourceLine[] = [];
  let start = 0;
  let defaultEnding = "";
  for (let end = body.indexOf("\n"); end !== -1; end = body.indexOf("\n", start)) {
    const ending = end > start && body[end - 1] === "\r" ? "\r\n" : "\n";
    lines.push({ text: body.slice(start, end + 1 - ending.length), ending });
    defaultEnding ||= ending;
    start = end + 1;
  }
  if (start < body.length) lines.push({ text: body.slice(start), ending: "" });
  return { bom, lines, defaultEnding: defaultEnding || "\n" };
}
