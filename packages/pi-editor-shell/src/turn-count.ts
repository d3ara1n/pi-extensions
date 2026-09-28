/**
 * Count persisted user messages on the active session branch.
 *
 * @internal — exported for testing.
 */
export function countUserMessages(entries: readonly unknown[]): number {
  let count = 0;
  for (const entry of entries) {
    const candidate = entry as { type?: unknown; message?: { role?: unknown } } | null;
    if (candidate?.type === "message" && candidate.message?.role === "user") count++;
  }
  return count;
}

/**
 * Count persisted compaction entries on the active session branch.
 *
 * @internal — exported for testing.
 */
export function countCompactions(entries: readonly unknown[]): number {
  let count = 0;
  for (const entry of entries) {
    if ((entry as { type?: unknown } | null)?.type === "compaction") count++;
  }
  return count;
}
