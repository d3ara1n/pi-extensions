const MIN_GENERATION_TOKENS = 10;
const MIN_GENERATION_DURATION_MS = 250;

export type TpsTokenSource = "provider-output" | "provider-output-minus-reasoning";

/** @internal — exported for focused throughput tests. */
export interface ResponsePerformanceSample {
  outputTokens?: number;
  reasoningTokens?: number;
  reasoningExpected: boolean;
  turnStartedAt?: number;
  firstVisibleTextAt?: number;
  responseEndedAt?: number;
  hasVisibleText: boolean;
  hasToolCall: boolean;
  stopReason?: string;
}

/** @internal — exported for focused throughput tests. */
export interface ResponsePerformance {
  waitMs?: number;
  totalMs?: number;
  generationMs?: number;
  visibleTokens?: number;
  e2eTps?: number;
  generationTps?: number;
  tokenSource?: TpsTokenSource;
  throughputUnavailableReason?: string;
  generationUnavailableReason?: string;
}

function validTimestamp(value: number | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * Calculate client-observed response performance for one completed assistant message.
 *
 * End-to-end throughput includes all time after turn start: local request preparation,
 * network and queue latency, hidden reasoning, and visible generation. Generation
 * throughput follows the common TPOT boundary: response completion minus time to the
 * first visible text, divided across the remaining visible tokens.
 *
 * @internal — exported for focused throughput tests.
 */
export function calculateResponsePerformance(
  sample: ResponsePerformanceSample,
): ResponsePerformance {
  const result: ResponsePerformance = {};
  const start = sample.turnStartedAt;
  const first = sample.firstVisibleTextAt;
  const end = sample.responseEndedAt;

  if (validTimestamp(start) && validTimestamp(end) && end >= start) {
    result.totalMs = end - start;
  }
  if (
    validTimestamp(start) &&
    validTimestamp(first) &&
    validTimestamp(end) &&
    first >= start &&
    first <= end
  ) {
    result.waitMs = first - start;
    result.generationMs = end - first;
  }

  if (sample.stopReason === "error" || sample.stopReason === "aborted") {
    result.throughputUnavailableReason = "response failed or was aborted";
    return result;
  }
  if (sample.hasToolCall) {
    result.throughputUnavailableReason = "text and tool-call tokens are not separable";
    return result;
  }
  if (!sample.hasVisibleText) {
    result.throughputUnavailableReason = "response contained no visible text";
    return result;
  }

  const output = sample.outputTokens;
  const reasoning = sample.reasoningTokens;
  if (output == null || !Number.isFinite(output) || output < 0) {
    result.throughputUnavailableReason = "provider output-token usage is unavailable";
    return result;
  }
  // Some adapters normalize an omitted reasoning count to zero. When reasoning
  // was enabled or observed, zero is therefore ambiguous and cannot safely be
  // used to derive a visible-token count.
  if (sample.reasoningExpected && (reasoning == null || reasoning === 0)) {
    result.throughputUnavailableReason = "provider omitted usable reasoning-token usage";
    return result;
  }
  if (reasoning != null && (!Number.isFinite(reasoning) || reasoning < 0 || reasoning > output)) {
    result.throughputUnavailableReason = "provider reasoning-token usage is invalid";
    return result;
  }

  const visibleTokens = output - (reasoning ?? 0);
  if (visibleTokens <= 0) {
    result.throughputUnavailableReason = "provider reported no visible output tokens";
    return result;
  }

  result.visibleTokens = visibleTokens;
  result.tokenSource = reasoning == null
    ? "provider-output"
    : "provider-output-minus-reasoning";

  if (result.totalMs == null || result.totalMs <= 0) {
    result.throughputUnavailableReason = "end-to-end timing data is unavailable";
    return result;
  }
  result.e2eTps = visibleTokens / (result.totalMs / 1000);

  if (result.generationMs == null) {
    result.generationUnavailableReason = "first visible-text timing is unavailable";
  } else if (visibleTokens < MIN_GENERATION_TOKENS) {
    result.generationUnavailableReason = `fewer than ${MIN_GENERATION_TOKENS} visible tokens`;
  } else if (result.generationMs < MIN_GENERATION_DURATION_MS) {
    result.generationUnavailableReason = `visible generation lasted less than ${MIN_GENERATION_DURATION_MS} ms`;
  } else {
    // N visible tokens span N - 1 post-first-token intervals.
    result.generationTps = (visibleTokens - 1) / (result.generationMs / 1000);
  }

  return result;
}
