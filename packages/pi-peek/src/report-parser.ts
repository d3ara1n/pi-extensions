const SUMMARY_OPEN = "<peek-summary>";
const SUMMARY_CLOSE = "</peek-summary>";
const REPORT_OPEN = "<peek-report>";
const REPORT_CLOSE = "</peek-report>";
const TAGS = [SUMMARY_OPEN, SUMMARY_CLOSE, REPORT_OPEN, REPORT_CLOSE];

export interface ParsedPeekReport {
  report: string;
  summary: string;
  reportMode: "tagged" | "fallback";
}

/** Derive a compact summary when the model does not supply one. */
export function summarizePeekReport(report: string): string {
  const normalized = report
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(normalized);
  return chars.length > 160 ? `${chars.slice(0, 157).join("")}…` : normalized;
}

/**
 * Incremental tag capture, independent of text outside the tags or tag order.
 * Only report bodies reach onReport. A missing closing tag captures through EOF.
 * Delimiters are reserved protocol tokens; literal examples must escape their angle brackets.
 */
export class PeekReportParser {
  private state: "outside" | "summary" | "report" = "outside";
  private pending = "";
  private summaryText = "";
  private reportText = "";
  private sawReport = false;
  private separateReport = false;
  private closed = false;
  private readonly onReport: (delta: string) => void;

  constructor(onReport: (delta: string) => void = () => {}) {
    this.onReport = onReport;
  }

  push(delta: string): void {
    if (this.closed) throw new Error("peek: report parser is already closed.");
    this.pending += delta;
    for (;;) {
      let index = -1;
      let tag = "";
      for (const candidate of TAGS) {
        const found = this.pending.indexOf(candidate);
        if (found >= 0 && (index < 0 || found < index)) {
          index = found;
          tag = candidate;
        }
      }
      if (index < 0) {
        // Retain only the suffix that may become a delimiter in the next delta.
        let hold = 0;
        for (const candidate of TAGS) {
          for (
            let length = Math.min(this.pending.length, candidate.length - 1);
            length > hold;
            length--
          ) {
            if (candidate.startsWith(this.pending.slice(-length))) {
              hold = length;
              break;
            }
          }
        }
        this.accept(this.pending.slice(0, this.pending.length - hold));
        this.pending = this.pending.slice(this.pending.length - hold);
        return;
      }
      this.accept(this.pending.slice(0, index));
      this.pending = this.pending.slice(index + tag.length);
      if (tag === SUMMARY_OPEN) {
        if (this.summaryText) this.summaryText += " ";
        this.state = "summary";
      } else if (tag === REPORT_OPEN) {
        this.sawReport = true;
        this.separateReport = this.reportText.length > 0;
        this.state = "report";
      } else if (
        (tag === SUMMARY_CLOSE && this.state === "summary") ||
        (tag === REPORT_CLOSE && this.state === "report")
      ) {
        this.state = "outside";
      }
    }
  }

  /** Finish a successful terminal response. Untagged fallback is never emitted before this call. */
  finish(lastTextBlock: string): ParsedPeekReport {
    if (this.closed) throw new Error("peek: report parser is already closed.");
    this.closed = true;
    this.accept(this.pending);
    this.pending = "";
    if (this.reportText.trim()) {
      return {
        report: this.reportText,
        summary: this.summaryText.trim() || summarizePeekReport(this.reportText),
        reportMode: "tagged",
      };
    }
    if (this.sawReport || !lastTextBlock.trim())
      throw new Error("peek: model returned an empty report.");
    this.reportText = lastTextBlock;
    this.onReport(lastTextBlock);
    return {
      report: lastTextBlock,
      summary: summarizePeekReport(lastTextBlock),
      reportMode: "fallback",
    };
  }

  private accept(text: string): void {
    if (!text) return;
    if (this.state === "summary") {
      this.summaryText += text;
    } else if (this.state === "report") {
      const delta = (this.separateReport ? "\n\n" : "") + text;
      this.separateReport = false;
      this.reportText += delta;
      this.onReport(delta);
    }
  }
}
