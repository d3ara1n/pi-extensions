/**
 * The model's inbox of background subagent runs.
 *
 * Injected into the LLM context before every provider call via the `context`
 * event. The reminder lists every delegated run not yet delivered by a
 * subagent_check of a terminal snapshot on the active branch — queued,
 * running, and finished/failed alike — so the model cannot forget about
 * them. Delivery state is derived from the session tree (see
 * collectDeliveredIds), not tracked in the registry: branching past a check
 * re-arms the inbox, branching back silences it, and compaction un-delivers
 * naturally.
 *
 * Cache discipline: the reminder is prepended to the FIRST user message, so
 * it sits at a stable position in the message prefix. Its content must stay
 * byte-stable between state transitions — that rules out elapsed time on
 * running rows and any other live-derived detail. Only terminal rows may
 * carry a duration (frozen in elapsedMs at completion).
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { RunState, SubagentResult } from "./types.ts";
import { elapsedSeconds, taskPreview } from "./utils.ts";

/** One row of the inbox. RunHandle satisfies this shape structurally. */
export interface InboxEntry {
  id: string;
  role: string;
  task: string;
  state: RunState;
  snapshot: SubagentResult;
}

const INBOX_HEADER =
  "[background subagent runs — results are pull-only for the model: no completion notice wakes you. subagent_wait, then subagent_check to collect each run; a terminal check removes it from this list; runs missing here were already checked on this branch]";

/** `42s`, `3m12s`, `4m` — whole seconds, no live clocks. */
function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/** Status segment of one row: state plus its stable extras (duration, error). */
function inboxStatus(entry: InboxEntry): string {
  if (entry.state === "queued") return "queued";
  if (entry.state === "running") return "running";
  const secs = elapsedSeconds(entry.snapshot);
  const ran = secs != null ? ` (ran ${formatDuration(secs)})` : "";
  // Cancels are recorded with their own label — the model reading the inbox
  // must not mistake a deliberate stop ("we no longer need this") for a
  // crashed run. Same shape as the failed row, reason and frozen duration.
  if (entry.snapshot.stopReason === "cancelled") {
    const reason = taskPreview(entry.snapshot.errorMessage || "no reason recorded");
    return `cancelled — ${reason}${ran}`;
  }
  if (entry.state === "failed") {
    const reason = taskPreview(entry.snapshot.errorMessage || entry.snapshot.stderr || "unknown error");
    return `failed — ${reason}${ran}`;
  }
  const partial = entry.snapshot.stopReason === "budget_exceeded" ? ", partial — budget exceeded" : "";
  return `finished${partial}${ran}`;
}

/**
 * Build the inbox reminder text, or undefined when every delegated run has
 * already been checked on the active branch (nothing to remind about —
 * inject nothing, keep the context untouched and the provider cache fully
 * stable). The state guard pins the inbox's own invariant locally — only
 * terminal runs can ever count as delivered (collectDeliveredIds ignores
 * live-frame checks), so a past peek at a running run never silences it.
 */
export function buildInboxReminder(entries: Iterable<InboxEntry>, delivered: Set<string>): string | undefined {
  const rows: string[] = [];
  for (const entry of entries) {
    if (entry.state !== "queued" && entry.state !== "running" && delivered.has(entry.id)) continue;
    rows.push(`- ${entry.id} (${entry.role}) — ${inboxStatus(entry)} — "${taskPreview(entry.task)}"`);
  }
  if (rows.length === 0) return undefined;
  return `${INBOX_HEADER}\n${rows.join("\n")}`;
}

/** Message array type of the `context` event (AgentMessage[]). */
type ContextMessages = ContextEvent["messages"];

/**
 * Prepend the reminder at a cache-stable position: the first text block of
 * the first user message (or a synthetic leading user message when the
 * transcript does not start with one).
 */
export function injectReminder(messages: ContextMessages, reminder: string): ContextMessages {
  if (messages.length === 0) {
    return [{ role: "user", content: reminder, timestamp: 0 } as ContextMessages[number]];
  }
  const [first, ...rest] = messages;
  if (first.role === "user") {
    const content =
      typeof first.content === "string"
        ? `${reminder}\n\n${first.content}`
        : [{ type: "text", text: reminder }, ...first.content];
    return [{ ...first, content } as ContextMessages[number], ...rest];
  }
  return [
    { role: "user", content: reminder, timestamp: 0 } as ContextMessages[number],
    ...messages,
  ];
}
