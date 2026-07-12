import type { InvestigateMessage } from "@d3ara1n/pi-peek";

export interface PeekReferenceHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

export function buildPeekHistoryMessages(
  history: readonly PeekReferenceHistoryEntry[],
): InvestigateMessage[] {
  return history.map((item) => ({
    role: item.role,
    content: item.text.trim() || "(empty)",
  }));
}
