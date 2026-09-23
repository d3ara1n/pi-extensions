import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ReportStream } from "./report-stream.ts";
import { PeekReportParser } from "./report-parser.ts";
import { formatInvestigationStatus } from "./progress.ts";

const message = (...texts: string[]) =>
  ({ content: texts.map((text) => ({ type: "text", text })) }) as AssistantMessage;

const envelope =
  "I now have sufficient evidence to write the report.\n<peek-summary>Short finding</peek-summary>\nignored junction text\n<peek-report># Report\nEvidence.</peek-report>\nignored tail";

test("preamble, junction prose and trailing text do not disable tag capture at any chunk boundary", () => {
  for (let boundary = 0; boundary <= envelope.length; boundary++) {
    const chunks: string[] = [];
    const parser = new PeekReportParser((delta) => chunks.push(delta));
    parser.push(envelope.slice(0, boundary));
    parser.push(envelope.slice(boundary));
    const result = parser.finish(envelope);
    assert.deepEqual(result, {
      report: "# Report\nEvidence.",
      summary: "Short finding",
      reportMode: "tagged",
    });
    assert.equal(chunks.join(""), result.report);
  }
});

test("one-character deltas hide all delimiters and the summary while streaming the body", () => {
  const chunks: string[] = [];
  const parser = new PeekReportParser((delta) => chunks.push(delta));
  const prefix = "outside<peek-summary>秘密概要</peek-summary>between<peek-report>";
  for (const char of prefix) parser.push(char);
  assert.deepEqual(chunks, []);
  for (const char of "正文🙂") parser.push(char);
  assert.equal(chunks.join(""), "正文🙂");
  for (const char of "</peek-report>tail") parser.push(char);
  assert.equal(parser.finish(prefix + "正文🙂</peek-report>tail").summary, "秘密概要");
  assert.equal(chunks.join(""), "正文🙂");
});

test("report-only and unclosed report tags work without a summary or a closing tag", () => {
  const parser = new PeekReportParser();
  parser.push("outside<peek-report>## Finding\nEvidence");
  assert.deepEqual(parser.finish("unused fallback"), {
    report: "## Finding\nEvidence",
    summary: "Finding Evidence",
    reportMode: "tagged",
  });
  const missingSummaryClose = new PeekReportParser();
  missingSummaryClose.push("<peek-summary>Short<peek-report>Body</peek-report>");
  assert.equal(missingSummaryClose.finish("unused").report, "Body");
});

test("untagged text stays private until completion and fallback uses only the supplied last block", () => {
  const chunks: string[] = [];
  const parser = new PeekReportParser((delta) => chunks.push(delta));
  parser.push("earlier explanation");
  parser.push("final answer");
  assert.deepEqual(chunks, []);
  assert.deepEqual(parser.finish("final answer"), {
    report: "final answer",
    summary: "final answer",
    reportMode: "fallback",
  });
  assert.deepEqual(chunks, ["final answer"]);
});

test("stream extraction uses real deltas, joins split delimiters across blocks and reconciles missing suffixes", () => {
  const chunks: string[] = [];
  const stream = new ReportStream((delta) => chunks.push(delta));
  const partial = message("outside<peek-", "report>first second</peek-report>tail");
  stream.push({ type: "text_start", contentIndex: 0, partial });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "outside<peek-", partial });
  assert.deepEqual(chunks, []);
  stream.push({ type: "thinking_delta", contentIndex: 2, delta: "PRIVATE", partial });
  stream.push({ type: "text_start", contentIndex: 1, partial });
  stream.push({ type: "text_delta", contentIndex: 1, delta: "report>first", partial });
  assert.deepEqual(chunks, ["first"]);
  const result = stream.finish(partial);
  assert.equal(result.report, "first second");
  assert.equal(chunks.join(""), result.report);
});

test("fallback chooses the final text block and provider revisions are rejected", () => {
  const chunks: string[] = [];
  const stream = new ReportStream((delta) => chunks.push(delta));
  const partial = message("explanation", "final");
  stream.push({ type: "text_delta", contentIndex: 0, delta: "explanation", partial });
  assert.equal(stream.finish(partial).report, "final");
  assert.deepEqual(chunks, ["final"]);
  const revised = new ReportStream(() => {});
  revised.push({
    type: "text_delta",
    contentIndex: 0,
    delta: "prefix",
    partial: message("prefix"),
  });
  assert.throws(() => revised.finish(message("changed")), /revised text/);
});

test("compact progress counts only parsed report characters", () => {
  assert.equal(formatInvestigationStatus("thinking", 0), "thinking…");
  assert.equal(formatInvestigationStatus("outputting", 0), "outputting…");
  assert.equal(formatInvestigationStatus("reading", 0), "reading…");
  assert.equal(formatInvestigationStatus("outputting", 1400), "outputting… · 1.4k chars");
});

test("a missing suffix from an earlier text block is rejected instead of corrupting report order", () => {
  const stream = new ReportStream(() => {});
  const partial = message("<peek-report>abc", "d</peek-report>");
  stream.push({ type: "text_delta", contentIndex: 0, delta: "<peek-report>ab", partial });
  stream.push({ type: "text_delta", contentIndex: 1, delta: "d</peek-report>", partial });
  assert.throws(() => stream.finish(partial), /earlier text block/);
});

test("an explicitly empty report cannot turn its protocol tags into a fallback answer", () => {
  for (const text of ["<peek-report></peek-report>", "<peek-report> \n </peek-report>"]) {
    const parser = new PeekReportParser();
    parser.push(text);
    assert.throws(() => parser.finish(text), /empty report/);
  }
});
