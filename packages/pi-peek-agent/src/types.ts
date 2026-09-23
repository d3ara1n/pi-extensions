/**
 * pi-peek-agent shared types — the peek business layer.
 *
 * Only peek-specific types live here. Peer identity, discovery, and the
 * cross-instance transport moved to @d3ara1n/pi-mesh; import those from there.
 * What remains is the "investigate" wire protocol and the investigate-timeout config.
 */

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
  snapshotAt?: string;
  stopReason?: "stop" | "length";
  usage?: import("@d3ara1n/pi-peek").InvestigateResult["usage"];
}

/** Details carried by the peek tool's live partial results while streaming. */
export interface InvestigateProgressData {
  /** Peer-side investigation stage, e.g. "investigating" | "done" | "error". */
  stage: string;
  /** Characters released for display so far (post-envelope-filter). */
  chars: number;
}
