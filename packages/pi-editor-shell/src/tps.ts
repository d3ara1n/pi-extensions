const MIN_VISIBLE_TOKENS = 10;
const MIN_SAMPLE_DURATION_MS = 250;

/** @internal — exported for focused throughput tests. */
export interface VisibleTextTpsSample {
  outputTokens?: number;
  reasoningTokens?: number;
  firstTextDeltaAt?: number;
  lastTextDeltaAt?: number;
  hasToolCall: boolean;
  stopReason?: string;
}

/**
 * Calculate client-observed visible-text throughput for one completed response.
 *
 * The provider's reasoning count is removed when available because its tokens may
 * be generated before the first visible delta. Tool-call responses are excluded:
 * providers do not expose a portable split between text and serialized tool tokens.
 *
 * @internal — exported for focused throughput tests.
 */
export function calculateVisibleTextTps(sample: VisibleTextTpsSample): number | undefined {
  if (sample.hasToolCall || sample.stopReason === "error" || sample.stopReason === "aborted") {
    return undefined;
  }

  const output = sample.outputTokens;
  const reasoning = sample.reasoningTokens ?? 0;
  const first = sample.firstTextDeltaAt;
  const last = sample.lastTextDeltaAt;
  if (
    output == null ||
    !Number.isFinite(output) ||
    !Number.isFinite(reasoning) ||
    reasoning < 0 ||
    first == null ||
    last == null ||
    !Number.isFinite(first) ||
    !Number.isFinite(last)
  ) {
    return undefined;
  }

  const visibleTokens = output - reasoning;
  const elapsedMs = last - first;
  if (visibleTokens < MIN_VISIBLE_TOKENS || elapsedMs < MIN_SAMPLE_DURATION_MS) {
    return undefined;
  }

  // N received tokens span N - 1 inter-token intervals once TTFT is excluded.
  return (visibleTokens - 1) / (elapsedMs / 1000);
}
