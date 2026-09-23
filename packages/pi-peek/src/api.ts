import type { ContextEditEntry, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getModelRolesAPI, type ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { createInvestigation } from "./investigate.ts";
import { SessionSnapshot } from "./snapshot.ts";
import * as tracker from "./tracker.ts";
import type { PeekAPI, PeekConfig, PeekInvestigation } from "./types.ts";
import { DEFAULT_PEEK_CONFIG, PEEK_GLOBAL_KEY } from "./types.ts";

type LiveAPI = PeekAPI & { shutdown(): void };

/** @internal Dependencies for the session-scoped API. */
export interface PeekDeps {
  sessionManager: Pick<ExtensionContext["sessionManager"], "buildContextEntries">;
  config: PeekConfig;
  modelRoles?: Pick<ModelRolesAPI, "resolveRole" | "streamWithRole">;
}

/**
 * @internal Mirror pi's buildSessionProjection() over the active entry list so
 * the reference shows exactly what the session's main assistant sees: context
 * edits are applied (content replacement or omission), only the newest
 * compaction entry contributes, and edit records plus shell executions the
 * user excluded from context are dropped. Stays entry-shaped so
 * SessionSnapshot can still extract evidence (patches, truncation metadata).
 */
export function projectActiveEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  const edits = new Map<string, ContextEditEntry>();
  for (const entry of entries) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry);
  }
  let sawCompaction = false;
  const out: SessionEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "context_edit") continue;
    if (entry.type === "compaction") {
      // buildContextEntries() can retain an older compaction whose id lies
      // inside the newest retained range; only the newest contributes.
      if (sawCompaction) continue;
      sawCompaction = true;
      out.push(entry);
      continue;
    }
    if (entry.type === "message" && entry.message.role === "bashExecution" && entry.message.excludeFromContext) {
      continue; // user-typed ! shell: never sent to any model
    }
    const edit = edits.get(entry.id);
    if (!edit) {
      out.push(entry);
      continue;
    }
    if (edit.replacement === null) continue; // omitted from the model context
    // Replacement applies content only, and only to editable roles
    // (mirrors projectContextEntry: user/assistant/toolResult/custom).
    if (entry.type === "message") {
      const m = entry.message;
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") {
        out.push(entry);
        continue;
      }
      const content = edit.replacement.content;
      const asTextBlock = typeof content === "string" && (m.role === "assistant" || m.role === "toolResult");
      const clone = { ...m, content: asTextBlock ? [{ type: "text" as const, text: content }] : content };
      out.push({ ...entry, message: clone as unknown as typeof m });
      continue;
    }
    if (entry.type === "custom_message") {
      out.push({ ...entry, content: edit.replacement.content as typeof entry.content });
      continue;
    }
    out.push(entry);
    out.push(entry);
  }
  return out;
}

export function initPeekAPI(deps: PeekDeps): PeekAPI {
  shutdownPeekAPI();
  const cfg = { ...DEFAULT_PEEK_CONFIG, ...deps.config };
  const investigations = new Set<PeekInvestigation>();
  let closed = false;
  const capture = () => {
    if (closed) throw new Error("peek: session has closed.");
    // The side model sees exactly what the session's main assistant sees:
    // the active, compaction-aware context view (last compaction summary plus
    // everything kept after it) with pi's projection semantics applied
    // (context edits, newest compaction only, no context-excluded shells) —
    // not the full recording, which replays every branch entry compactions
    // dropped and can exceed the model window many times over.
    return new SessionSnapshot(projectActiveEntries(deps.sessionManager.buildContextEntries()));
    // the active, compaction-aware context view (last compaction summary plus
    // everything kept after it) — not the full recording, which replays every
    // branch entry compactions dropped and can exceed the model window many
    // times over on long sessions.
    return new SessionSnapshot(deps.sessionManager.buildContextEntries());
  };
  const api: LiveAPI = {
    createInvestigation(options = {}) {
      if (closed) throw new Error("peek: session has closed.");
      const roles = deps.modelRoles ?? getModelRolesAPI();
      const { model } = roles.resolveRole(cfg.role);
      if (!model) throw new Error(`peek: model unavailable for role "${cfg.role}".`);
      const inner = createInvestigation({
        snapshot: capture(), model, config: cfg, includeThinking: options.includeThinking,
        stream: (context, options) => roles.streamWithRole(cfg.role, context, { ...options, model }),
      });
      const investigation: PeekInvestigation = {
        snapshotAt: inner.snapshotAt,
        investigate: (question, options) => inner.investigate(question, options),
        dispose() {
          inner.dispose();
          investigations.delete(investigation);
        },
      };
      investigations.add(investigation);
      return investigation;
    },
    async investigate(question, options) {
      const investigation = api.createInvestigation(options);
      try {
        return await investigation.investigate(question, options);
      } finally {
        investigation.dispose();
      }
    },
    serializeMainConversation(options = {}) {
      const snapshot = capture();
      try { return snapshot.reference(options.includeThinking); }
      finally { snapshot.dispose(); }
    },
    getMainAgentStatus: tracker.getMainAgentStatus,
    shutdown() {
      closed = true;
      for (const investigation of investigations) investigation.dispose();
    },
  };
  (globalThis as any)[PEEK_GLOBAL_KEY] = api;
  return api;
}

/** @internal Release ephemeral investigations on shutdown/reload. */
export function shutdownPeekAPI(): void {
  const api = (globalThis as any)[PEEK_GLOBAL_KEY] as LiveAPI | undefined;
  api?.shutdown?.();
  delete (globalThis as any)[PEEK_GLOBAL_KEY];
}

export function getPeekAPI(): PeekAPI {
  const api = tryGetPeekAPI();
  if (!api) throw new Error("PeekAPI not initialized. Load @d3ara1n/pi-peek and wait for session_start.");
  return api;
}

export function tryGetPeekAPI(): PeekAPI | undefined {
  return (globalThis as any)[PEEK_GLOBAL_KEY] as PeekAPI | undefined;
}
