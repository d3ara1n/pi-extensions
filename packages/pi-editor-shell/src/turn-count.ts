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
