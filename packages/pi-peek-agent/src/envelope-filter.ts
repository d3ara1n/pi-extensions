/**
 * Streaming envelope filter — display-only incremental parser for the
 * `<peek-summary>`/`<peek-report>` envelope the investigator is asked to
 * produce (see formatInvestigationQuestion in index.ts).
 *
 * The authoritative split happens on the peer at completion time
 * (splitInvestigationReport, shipped back in the mesh response). This filter
 * only serves the requester's live display: it swallows the summary silently
 * (neither the collapsed nor the expanded view shows it while streaming) and
 * releases the report body as it arrives.
 *
 * Robustness mirrors the completion-time regex — a finished filter's display
 * always equals the authoritative report (the peer's split). Whitespace
 * tolerance mirrors the same regex: leading `^\s*`, an `\s*` run between
 * the tag pairs, trailing `\s*$`. Like the regex's non-greedy backtracking,
 * a close-tag candidate whose structure fails (junction mismatch, non-
 * whitespace tail, empty report body) is swallowed as body text and scanning
 * resumes after it; only content failures (blank summary) or a stream that
 * ends without a valid envelope fall back to RAW passthrough of everything
 * received so far (tags included).
 *   START   — hold through optional leading whitespace until the first bytes
 *             prove or contradict "<peek-summary>".
 *   SUMMARY — swallow silently; after "</peek-summary>" expect a whitespace
 *             run then "<peek-report>", and a non-blank summary.
 *   REPORT  — release text as it arrives; a tail that could still grow into
 *             "</peek-report>" is held back, so a tag split across deltas is
 *             never shown as text.
 *   TAIL    — after "</peek-report>" only whitespace then end-of-stream is
 *             allowed.
 *   RAW     — passthrough of the full raw text from byte 0.
 */

const SUMMARY_OPEN = "<peek-summary>";
const SUMMARY_CLOSE = "</peek-summary>";
const REPORT_OPEN = "<peek-report>";
const REPORT_CLOSE = "</peek-report>";

type FilterState = "start" | "summary" | "report" | "tail" | "raw";

export class EnvelopeFilter {
  private state: FilterState = "start";
  private raw = "";
  /** Start of the current region: summary body in SUMMARY, report body afterwards. */
  private regionStart = 0;
  /** Where the current tag search has reached; a straddling tag may start tagLen-1 earlier. */
  private scanFrom = 0;
  /** Where the report body ends (TAIL state, once REPORT_CLOSE is found). */
  private reportEnd = 0;
  /** Where the tail region starts (TAIL state: right after REPORT_CLOSE). */
  private tailStart = 0;

  /**
   * Text released for display so far: the streamed report body, or the full
   * raw text once the envelope proved malformed. Never includes the summary.
   */
  get displayText(): string {
    switch (this.state) {
      case "raw":
        return this.raw;
      case "report": {
        // A tail that may still grow into the closing tag stays held back.
        const hold = holdBackLength(this.raw, this.regionStart);
        return this.raw.slice(this.regionStart, this.raw.length - hold);
      }
      case "tail":
        return this.raw.slice(this.regionStart, this.reportEnd);
      default:
        return ""; // start/summary: nothing displayed yet
    }
  }

  /** Feed one streamed delta. */
  push(delta: string): void {
    this.raw += delta;
    this.step(false);
  }

  /** End of stream: settle undecided holds the way the completion parse would. */
  finish(): void {
    this.step(true);
  }

  private step(finished: boolean): void {
    if (this.state === "start") {
      // Leading whitespace before the envelope is tolerated (^\s* in the regex).
      const lead = leadingWhitespaceLength(this.raw);
      const rest = this.raw.slice(lead);
      if (rest.startsWith(SUMMARY_OPEN)) {
        this.regionStart = this.scanFrom = lead + SUMMARY_OPEN.length;
        this.state = "summary";
      } else if (rest.length < SUMMARY_OPEN.length && SUMMARY_OPEN.startsWith(rest)) {
        if (finished) this.state = "raw"; // stream ended before the opening tag completed
        return; // still a possible prefix of the opening tag — keep holding
      } else {
        this.state = "raw"; // does not start with the envelope → passthrough
        return;
      }
    }
    if (this.state === "summary") return this.stepSummary(finished);
    if (this.state === "report") return this.stepReport(finished);
    if (this.state === "tail") return this.stepTail(finished);
    // raw: displayText is the raw text itself
  }

  private stepSummary(finished: boolean): void {
    for (;;) {
      const close = this.raw.indexOf(SUMMARY_CLOSE, this.scanFrom);
      if (close < 0) {
        // Keep only the overlap where a straddling close tag could still start.
        this.scanFrom = Math.max(this.regionStart, this.raw.length - (SUMMARY_CLOSE.length - 1));
        if (finished) this.state = "raw";
        return;
      }
      const tail = this.raw.slice(close + SUMMARY_CLOSE.length);
      // Junction: any whitespace run, then <peek-report> (\s* in the regex).
      const ws = leadingWhitespaceLength(tail);
      const rest = tail.slice(ws);
      if (rest.startsWith(REPORT_OPEN)) {
        const summary = this.raw.slice(this.regionStart, close);
        if (!summary.trim()) {
          this.state = "raw"; // blank summary → malformed, mirrors the completion parse
          return;
        }
        this.regionStart = this.scanFrom = close + SUMMARY_CLOSE.length + ws + REPORT_OPEN.length;
        this.state = "report";
        return this.stepReport(finished);
      }
      if (!finished && REPORT_OPEN.startsWith(rest)) return; // junction may still complete
      // Structural failure: like the non-greedy regex, swallow this close tag
      // as summary body and keep searching for a later candidate.
      this.scanFrom = close + 1;
    }
  }

  private stepReport(finished: boolean): void {
    for (;;) {
      const close = this.raw.indexOf(REPORT_CLOSE, this.scanFrom);
      if (close < 0) {
        this.scanFrom = Math.max(this.regionStart, this.raw.length - (REPORT_CLOSE.length - 1));
        if (finished) this.state = "raw"; // never closed → malformed
        return;
      }
      if (close === this.regionStart) {
        // Empty report body: the regex needs ≥1 body char, so it backtracks
        // past this candidate — treat the tag as body text and keep scanning.
        this.scanFrom = close + 1;
        continue;
      }
      if (/^\s*$/.test(this.raw.slice(close + REPORT_CLOSE.length))) {
        // Only trailing whitespace may follow the close (\s*$). Provisional:
        // non-whitespace arriving later re-opens the scan in stepTail.
        this.reportEnd = close;
        this.tailStart = close + REPORT_CLOSE.length;
        this.state = "tail";
        return;
      }
      // Structural failure — swallow this close tag as report body, keep scanning.
      this.scanFrom = close + 1;
    }
  }

  private stepTail(finished: boolean): void {
    const tail = this.raw.slice(this.tailStart);
    if (/^\s*$/.test(tail)) return; // still only trailing whitespace — candidate stays valid
    // Non-whitespace after this candidate's close: like the regex, backtrack
    // past it (the tag becomes report body) and keep scanning.
    this.state = "report";
    this.scanFrom = this.reportEnd + 1;
    this.stepReport(finished);
  }
}

/**
 * Longest proper suffix of raw[regionStart..] that is still a proper prefix of
 * REPORT_CLOSE — the part that cannot be shown yet because it might be the
 * first characters of the closing tag straddling into the next delta.
 */
function holdBackLength(raw: string, regionStart: number): number {
  const max = Math.min(raw.length - regionStart, REPORT_CLOSE.length - 1);
  for (let len = max; len > 0; len--) {
    if (REPORT_CLOSE.startsWith(raw.slice(raw.length - len))) return len;
  }
  return 0;
}
/** Length of the leading whitespace run (same \s as the completion regex). */
function leadingWhitespaceLength(text: string): number {
  return text.length - text.replace(/^\s+/, "").length;
}
