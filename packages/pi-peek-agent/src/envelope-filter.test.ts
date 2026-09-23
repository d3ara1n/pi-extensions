import assert from "node:assert/strict";
import { test } from "node:test";
import { EnvelopeFilter } from "./envelope-filter.ts";
import { splitInvestigationReport } from "./index.ts";

const SUMMARY = "Fox is refactoring the auth middleware";
const REPORT = "The last 40 minutes show edits to tokenRefresh() in auth.ts,\nincluding a retry fix and a literal <peek-report> in code.";

/** Raw streams covering well-formed and malformed envelopes. */
const STREAMS: string[] = [
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>${REPORT}</peek-report>`,
  // Live-observed deviation: blank line between the tag pairs (glm-5.3-flash).
  `<peek-summary>${SUMMARY}</peek-summary>\n\n<peek-report>\n${REPORT}\n</peek-report>`,
  // Leading blank line + indented junction + trailing blank lines.
  `\n<peek-summary>${SUMMARY}</peek-summary>\n  \n  <peek-report>${REPORT}</peek-report>\n\n`,
  `<peek-summary>${SUMMARY}</peek-summary>\r\n<peek-report>${REPORT}</peek-report>\r\n`,
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>${REPORT}</peek-report>\n`,
  "No envelope at all, just a plain answer.",
  `<peek-summary>  </peek-summary>\n<peek-report>${REPORT}</peek-report>`,
  `<peek-summary>${SUMMARY}</peek-summary>\nno report tag follows`,
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report></peek-report>`,
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>${REPORT}`,
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>${REPORT}</peek_report>`,
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>${REPORT}</peek-report>\nextra`,
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>ab</peek-report>\n\n`,
  `leading text before <peek-summary>${SUMMARY}</peek-summary>\n<peek-report>${REPORT}</peek-report>`,
  // Close-tag literals inside bodies: the non-greedy regex backtracks past
  // earlier failing candidates; the filter must agree.
  `<peek-summary>${SUMMARY}</peek-summary><peek-report>literal </peek-report> text</peek-report>`,
  `<peek-summary>a</peek-summary>x<peek-summary>b</peek-summary>\n<peek-report>${REPORT}</peek-report>`,
  `<peek-summary>  </peek-summary>x<peek-summary>b</peek-summary>\n<peek-report>${REPORT}</peek-report>`,
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report></peek-report>hi</peek-report>`,
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>body</peek-report>\n</peek-report>`,
  `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>a</peek-report>b</peek-report>`,
  "<peek-su",
  "   ",
];

function chunkEvery(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : [""];
}

test("a finished filter's display always equals the completion-time report, for any chunking", () => {
  for (const raw of STREAMS) {
    const expected = splitInvestigationReport(raw).report;
    for (const size of [1, 2, 3, 5, 8, 13, 14, 15, 29, 10_000]) {
      const filter = new EnvelopeFilter();
      for (const chunk of chunkEvery(raw, size)) filter.push(chunk);
      filter.finish();
      assert.equal(filter.displayText, expected, `raw=${JSON.stringify(raw)} chunkSize=${size}`);
    }
    // Chunks split exactly inside each envelope marker (tag straddling deltas).
    for (const tag of ["<peek-summary>", "</peek-summary>", "\n<peek-report>", "</peek-report>"]) {
      const at = raw.indexOf(tag);
      if (at < 0) continue;
      for (let cut = 1; cut < tag.length; cut++) {
        const filter = new EnvelopeFilter();
        filter.push(raw.slice(0, at + cut));
        filter.push(raw.slice(at + cut));
        filter.finish();
        assert.equal(filter.displayText, expected, `raw=${JSON.stringify(raw)} tag=${JSON.stringify(tag)} cut=${cut}`);
      }
    }
  }
});

test("report text streams out while the summary stays hidden", () => {
  const filter = new EnvelopeFilter();
  filter.push("<peek-su");
  assert.equal(filter.displayText, "");
  filter.push("mmary>partial summ");
  assert.equal(filter.displayText, "");
  filter.push("ary</peek-summary>\n<peek-report>bo");
  assert.equal(filter.displayText, "bo");
  filter.push("dy text");
  assert.equal(filter.displayText, "body text");
});

test("a tail that may still grow into the closing tag is held back", () => {
  const filter = new EnvelopeFilter();
  filter.push(`<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>value of a <`);
  assert.equal(filter.displayText, "value of a ");
  filter.push(" b comparison");
  assert.equal(filter.displayText, "value of a < b comparison");
  filter.push("</peek-report>");
  assert.equal(filter.displayText, "value of a < b comparison");
  filter.finish();
  assert.equal(filter.displayText, "value of a < b comparison");
});

test("a close-tag literal inside the report body is recovered like the regex", () => {
  const filter = new EnvelopeFilter();
  filter.push(`<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>literal </peek-report>`);
  // Provisional candidate: the body so far is committed optimistically.
  assert.equal(filter.displayText, "literal ");
  filter.push(" text</peek-report>");
  assert.equal(filter.displayText, "literal </peek-report> text");
  filter.finish();
  assert.equal(filter.displayText, "literal </peek-report> text");
});

test("a half-received junction holds until it completes or deviates", () => {
  const filter = new EnvelopeFilter();
  filter.push(`<peek-summary>${SUMMARY}</peek-summary>\n\n`);
  assert.equal(filter.displayText, ""); // still inside the junction whitespace
  filter.push("<peek-report>bo");
  assert.equal(filter.displayText, "bo");
});

test("a half-received junction holds until it completes or deviates", () => {
  const filter = new EnvelopeFilter();
  filter.push(`<peek-summary>${SUMMARY}</peek-summary>\n<peek-re`);
  assert.equal(filter.displayText, "");
  filter.push("port>body");
  assert.equal(filter.displayText, "body");
});

test("unstructured output passes through unchanged from the first byte", () => {
  const filter = new EnvelopeFilter();
  filter.push("Just a plain ");
  assert.equal(filter.displayText, "Just a plain ");
  filter.push("answer.");
  assert.equal(filter.displayText, "Just a plain answer.");
  filter.finish();
  assert.equal(filter.displayText, "Just a plain answer.");
});

test("a malformed envelope falls back to raw passthrough including already-swallowed text", () => {
  const filter = new EnvelopeFilter();
  filter.push(`<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>partial`);
  assert.equal(filter.displayText, "partial");
  filter.push("</peek_report>"); // typo — never matches the real closing tag
  assert.equal(filter.displayText, "partial</peek_report>");
  filter.finish(); // never closed → whole raw becomes the report
  assert.equal(filter.displayText, `<peek-summary>${SUMMARY}</peek-summary>\n<peek-report>partial</peek_report>`);
});
