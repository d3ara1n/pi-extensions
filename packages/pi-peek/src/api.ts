/**
 * PeekAPI singleton — LOCAL consult capability only.
 *
 * Assembles serialize + investigate + tracker. State stored on globalThis
 * (key __piPeek) to survive module identity mismatches (extension loaded by
 * absolute path vs import via workspace symlink). getPeekAPI() provides
 * type-safe access; consumers never touch globalThis.
 *
 * No cross-instance machinery here — that lives in @d3ara1n/pi-peek-agent,
 * which calls PeekAPI.investigate() to serve remote asks.
 */

import { serializeConversation } from "./serialize.ts";
import { investigateWithReference } from "./investigate.ts";
import * as tracker from "./tracker.ts";
import type {
  InvestigateOptions,
  InvestigateResult,
  MainAgentStatus,
  PeekAPI,
  PeekConfig,
} from "./types.ts";
import { DEFAULT_PEEK_CONFIG, PEEK_GLOBAL_KEY } from "./types.ts";

export interface PeekDeps {
  /** Read-only session manager (for serialize). */
  sessionManager: any;
  /** Resolved config (already merged with defaults). */
  config: PeekConfig;
}

export function initPeekAPI(deps: PeekDeps): PeekAPI {
  const cfg = { ...DEFAULT_PEEK_CONFIG, ...deps.config };
  const sessionManager = deps.sessionManager;

  const api: PeekAPI = {
    serializeMainConversation(): string {
      const branch = sessionManager?.getBranch?.() ?? [];
      return serializeConversation(branch, cfg);
    },

    async investigate(question, opts: InvestigateOptions = {}): Promise<InvestigateResult> {
      const ref = opts.referenceText ?? api.serializeMainConversation();
      return investigateWithReference(ref, question, { ...opts, role: opts.role ?? cfg.role });
    },

    getMainAgentStatus(): MainAgentStatus {
      return tracker.getMainAgentStatus();
    },
  };

  (globalThis as any)[PEEK_GLOBAL_KEY] = api;
  return api;
}

/** Get the initialized PeekAPI. Throws if initPeekAPI() hasn't run. */
export function getPeekAPI(): PeekAPI {
  const api = (globalThis as any)[PEEK_GLOBAL_KEY] as PeekAPI | undefined;
  if (!api) {
    throw new Error(
      "PeekAPI not initialized. Ensure @d3ara1n/pi-peek extension is loaded and session_start has fired.",
    );
  }
  return api;
}

/** Non-throwing getter (for hooks that fire before session_start). */
export function tryGetPeekAPI(): PeekAPI | undefined {
  return (globalThis as any)[PEEK_GLOBAL_KEY] as PeekAPI | undefined;
}
