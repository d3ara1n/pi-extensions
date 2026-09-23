/**
 * pi-peek-agent shared types — the peek business layer.
 *
 * Only peek-specific types live here. Peer identity, discovery, and the
 * cross-instance transport moved to @d3ara1n/pi-mesh; import those from there.
 * What remains is the "investigate" wire protocol and the investigate-timeout config.
 */

import type { InvestigateProgress } from "@d3ara1n/pi-peek";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PeekConfig {
  /** Synchronous wait timeout for a remote investigation. Default 120s. */
  investigateTimeoutMs?: number;
}

export const DEFAULT_PEEK_CONFIG: Required<Pick<PeekConfig, "investigateTimeoutMs">> = {
  investigateTimeoutMs: 120_000,
};

// ---------------------------------------------------------------------------
// "investigate" wire protocol (carried over the mesh's request channel)
// ---------------------------------------------------------------------------

/** Mesh request type string for a peek investigation. */
export const INVESTIGATE_TYPE = "investigate";

export interface InvestigateRequestData {
  question: string;
  includeThinking?: boolean;
}

export interface InvestigateResponseData {
  report: string;
  summary?: string;
  reportMode?: "tagged" | "fallback";
  snapshotAt?: string;
  stopReason?: "stop" | "length";
  usage?: import("@d3ara1n/pi-peek").InvestigateResult["usage"];
  metrics?: import("@d3ara1n/pi-peek").InvestigateMetrics;
}

/** Details carried by the peek tool's live partial results while streaming. */
export interface InvestigateProgressData
  extends Partial<Omit<InvestigateProgress, "stage" | "chars">> {
  /** Serving-side activity, or local "connecting"; thinking text is never transported. */
  stage: string;
  /** Report-body characters released for display so far. */
  chars: number;
}
