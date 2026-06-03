/**
 * pi-usage-block — Status bar display
 *
 * Polls registered UsageProviders and renders quota status
 * via ctx.ui.setStatus("usage-block", ...) for powerline customItems.
 *
 * powerline config example:
 *   "customItems": [{ "id": "usage", "statusKey": "usage-block",
 *                     "position": "right", "prefix": "⚡", "color": "accent" }]
 *
 * Optional settings under "usageBlock":
 *   refreshIntervalMs — poll interval in ms (default 60000)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { usageRegistry, type UsageWindow } from "@d3ara1n/pi-usage-block-core";

const STATUS_KEY = "usage-block";

// ── Formatting ────────────────────────────────────────────────────────────

function fmtPct(used: number, limit: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return "—";
  // When limit=100 and used is already a percentage, just use it directly
  if (limit === 100) return `${Math.round(used)}%`;
  return `${Math.round((used / limit) * 100)}%`;
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d${rh}h` : `${d}d`;
}

function fmtWindow(w: UsageWindow): string {
  const ratio = w.limit > 0 && Number.isFinite(w.used) ? w.used / w.limit : 0;
  const dot = ratio >= 0.9 ? "🔴" : ratio >= 0.7 ? "🟡" : "🟢";
  let text = `${dot}${fmtPct(w.used, w.limit)}`;
  if (w.resetAt) text += ` ↺${fmtCountdown(w.resetAt.getTime() - Date.now())}`;
  return text;
}

function fmtProvider(name: string, windows: UsageWindow[]): string {
  if (!windows.length) return name;
  const parts = windows.map(w => fmtWindow(w));
  return `${name} ${parts.join(" ")}`;
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let ctx: any;
  let timer: ReturnType<typeof setInterval> | undefined;
  let alive = false;

  /** Refresh status bar. Safe to call at any time — guards ctx validity. */
  async function refresh() {
    if (!ctx || !alive) return;

    try {
      const providers = usageRegistry.getAll();
      if (!providers.length) {
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "usage: no providers"));
        return;
      }

      const parts: string[] = [];
      for (const p of providers) {
        try {
          const windows = await p.fetchUsage();
          if (!ctx || !alive) return; // session died during await
          if (windows.length) parts.push(fmtProvider(p.name, windows));
        } catch { /* skip failed provider */ }
      }

      if (!ctx || !alive) return;
      ctx.ui.setStatus(STATUS_KEY, parts.length ? parts.join(" │ ") : undefined);
    } catch (e) {
      console.error("[usage-block] refresh failed:", e);
    }
  }

  pi.on("session_start", async (_e, c) => {
    ctx = c;
    alive = true;
    const ms: number = (c as any).settings?.usageBlock?.refreshIntervalMs ?? 60_000;
    await refresh();
    timer = setInterval(() => { if (alive) refresh(); }, ms);
  });

  pi.on("session_shutdown", () => {
    alive = false;
    clearInterval(timer);
    timer = undefined;
    ctx = undefined;
  });
}
