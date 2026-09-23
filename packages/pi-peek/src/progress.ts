/** Shared compact status text for the local overlay and remote tool renderer. */
export function formatInvestigationStatus(stage: string, chars = 0): string {
  const label = stage === "done" || stage === "error" ? stage : `${stage}…`;
  if (chars <= 0) return label;
  const count =
    chars < 1000
      ? String(chars)
      : chars < 1_000_000
        ? `${(chars / 1000).toFixed(1)}k`
        : `${(chars / 1_000_000).toFixed(1)}M`;
  return `${label} · ${count} chars`;
}
