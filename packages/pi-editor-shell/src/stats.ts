/** Usage fields consumed by the shell's session statistics. */
export interface UsageSnap {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface EntrySnap {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role: string; usage?: UsageSnap };
  usage?: UsageSnap;
}

interface StatsSource {
  getEntries(): readonly EntrySnap[];
  getLeafId(): string | null;
}

/** @internal Raw statistics shared by the border and debug command. */
export interface SessionStats {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestUsage: UsageSnap | undefined;
  userMessages: number;
  compactions: number;
}

/**
 * @internal Aggregate session usage and active-branch counts in one reverse pass.
 * Entries are append-only, so every parent precedes its children. Following the
 * leaf's parent chain while scanning avoids a separate getBranch() traversal.
 */
export function collectSessionStats(entries: readonly EntrySnap[], leafId: string | null): SessionStats {
  const stats: SessionStats = {
    input: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    latestUsage: undefined, userMessages: 0, compactions: 0,
  };
  let branchId = leafId;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (branchId !== null && entry.id === branchId) {
      if (entry.type === "message" && entry.message?.role === "user") stats.userMessages++;
      if (entry.type === "compaction") stats.compactions++;
      branchId = entry.parentId;
    }

    let usage: UsageSnap | undefined;
    if (entry.type === "message") {
      const message = entry.message;
      if (message?.role === "assistant") {
        usage = message.usage;
        if (usage) {
          stats.latestUsage ??= usage;
          stats.input += usage.input ?? 0;
          stats.cacheRead += usage.cacheRead ?? 0;
          stats.cacheWrite += usage.cacheWrite ?? 0;
        }
      } else if (message?.role === "toolResult") {
        usage = message.usage;
      }
    } else if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
      usage = entry.usage;
    }
    const cost = usage?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) stats.cost += cost;
  }
  return stats;
}

/**
 * @internal One snapshot per persisted leaf, shared by all shell statistics.
 * Read after persistence: message_end handlers run before the message is appended.
 * Create a fresh cache when the session starts or is replaced.
 */
export class SessionStatsCache {
  private leafId: string | null | undefined;
  private snapshot: SessionStats | undefined;

  read(source: StatsSource): SessionStats {
    const leafId = source.getLeafId();
    if (!this.snapshot || this.leafId !== leafId) {
      this.snapshot = collectSessionStats(source.getEntries(), leafId);
      this.leafId = leafId;
    }
    return this.snapshot;
  }
}
