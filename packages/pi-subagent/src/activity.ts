import type { ActivityEntry } from "./types.ts";

/** @internal Insert live activity before pending entries, keeping the queue at the tail. */
export function appendActivity(log: ActivityEntry[], entry: ActivityEntry): number {
  const queued = entry.status === "queued" ? -1 : log.findIndex((item) => item.status === "queued");
  const index = queued < 0 ? log.length : queued;
  log.splice(index, 0, entry);
  return index;
}

/** @internal Match the user message actually consumed by the child, one occurrence at a time. */
export function consumeSteer(log: ActivityEntry[], message: { role?: string; content?: unknown }): boolean {
  if (message.role !== "user") return false;
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      : undefined;
  const entry = log.find((item) => item.kind === "steer" && item.status === "queued" && item.text === text);
  if (!entry) return false;
  entry.status = "done";
  return true;
}
