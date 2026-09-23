/** Initializes the shared PeekAPI and main-agent tracking hooks for consumer extensions. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initPeekAPI, shutdownPeekAPI } from "./api.ts";
import * as tracker from "./tracker.ts";
import { loadPeekConfig } from "./config.ts";

export { getPeekAPI } from "./api.ts";
export { PeekContextOverflowError } from "./types.ts";
export { formatInvestigationStatus } from "./progress.ts";
export { PeekReportParser, summarizePeekReport, type ParsedPeekReport } from "./report-parser.ts";
export type {
  InvestigateOptions,
  PeekReferenceOptions,
  PeekAPI,
  PeekInvestigation,
  InvestigateStage,
  InvestigateProgress,
  InvestigateMetrics,
  MainAgentStatus,
  InvestigateResult,
  PeekConfig,
} from "./types.ts";

export default function registerPeekExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    initPeekAPI({
      sessionManager: ctx.sessionManager,
      config: loadPeekConfig(ctx.cwd),
    });
  });

  pi.on("session_shutdown", () => shutdownPeekAPI());

  // ── tracker hooks (fire every turn; feed the status snapshot) ─────────
  pi.on("turn_start", (event) => tracker.onTurnStart(event.turnIndex));
  pi.on("turn_end", (event) => tracker.onTurnEnd(event.turnIndex));
  pi.on("tool_execution_start", (event) => tracker.onToolStart(event.toolName, event.args));
  pi.on("tool_execution_end", (event) => tracker.onToolEnd(event.toolName));
}
