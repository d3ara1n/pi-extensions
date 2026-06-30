/**
 * pi-usage-block — Status bar display
 *
 * Displays usage quota for the currently active pi provider.
 *
 * Two data sources are supported:
 *   api:     timer-based polling via fetchUsage()
 *   headers: event-driven via after_provider_response + headerMapping
 *
 * Usage providers register themselves via usageRegistry from
 * @d3ara1n/pi-usage-block-core. The display only queries the one
 * whose id matches ctx.model.provider.
 *
 * Optional settings under "usageBlock":
 *   refreshIntervalMs — poll interval in ms for api-source providers (default 60000)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { usageRegistry, parseHeaderUsage, type UsageWindow } from "@d3ara1n/pi-usage-block-core";

const STATUS_KEY = "usage-block";

// Nerd Font nf-fa-circle (U+F111) — single glyph, colored per severity via theme.
type Theme = { fg(color: string, text: string): string };

// ── Formatting ────────────────────────────────────────────────────────────

function fmtPct(used: number, limit: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return "—";
  if (limit === 100) return `${Math.round(used)}%`;
  return `${Math.round((used / limit) * 100)}%`;
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60),
    rm = m % 60;
  if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
  const d = Math.floor(h / 24),
    rh = h % 24;
  return rh ? `${d}d${rh}h` : `${d}d`;
}

function fmtWindow(w: UsageWindow, theme: Theme): string {
  const ratio = w.limit > 0 && Number.isFinite(w.used) ? w.used / w.limit : 0;
  const level = ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "success";
  let text = `${theme.fg(level, "\uf111")}${theme.fg("dim", fmtPct(w.used, w.limit))}`;
  if (w.resetAt) text += theme.fg("dim", ` ↺${fmtCountdown(w.resetAt.getTime() - Date.now())}`);
  return text;
}

function fmtProvider(name: string, windows: UsageWindow[], theme: Theme): string {
  if (!windows.length) return name;
  const parts = windows.map((w) => fmtWindow(w, theme));
  return `${theme.fg("dim", name)} ${parts.join(" ")}`;
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let ctx: any;
  let timer: ReturnType<typeof setInterval> | undefined;
  let alive = false;
  let activeProviderId: string | undefined;
  /** Cached windows from the latest headers-based response. */
  let headerWindows: UsageWindow[] | undefined;

  // ── Helpers ────────────────────────────────────────────────────────────

  function getActiveUsageProvider() {
    if (!activeProviderId) return undefined;
    return usageRegistry.get(activeProviderId);
  }

  /** Render windows to the status bar. */
  function render(windows: UsageWindow[] | undefined) {
    if (!ctx || !alive) return;
    if (!windows?.length) {
      clear();
      return;
    }
    const provider = getActiveUsageProvider();
    const name = provider?.name ?? activeProviderId ?? "usage";
    ctx.ui.setStatus(STATUS_KEY, fmtProvider(name, windows, ctx.ui.theme));
  }

  /** Remove the status bar entry. */
  function clear() {
    if (!ctx || !alive) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  // ── API-source refresh (timer-driven) ──────────────────────────────────

  async function refresh() {
    if (!ctx || !alive) return;
    try {
      const provider = getActiveUsageProvider();
      if (!provider || provider.source !== "api" || !provider.fetchUsage) return;
      const windows = await provider.fetchUsage();
      if (!ctx || !alive) return;
      render(windows);
    } catch {
      // fetch failed silently — keep previous data if any
    }
  }

  // ── Headers-source handling (event-driven) ─────────────────────────────

  pi.on("after_provider_response", (event) => {
    if (!alive) return;
    const provider = getActiveUsageProvider();
    if (!provider || provider.source !== "headers" || !provider.headerMapping) return;
    const w = parseHeaderUsage(event.headers, provider.headerMapping);
    if (w) {
      headerWindows = [w];
      render([w]);
    }
  });

  // ── Model tracking ─────────────────────────────────────────────────────

  function setActive(id: string | undefined) {
    activeProviderId = id;
    headerWindows = undefined;
    const provider = getActiveUsageProvider();
    if (!provider) {
      clear();
      return;
    }
    if (provider.source === "api") {
      // Kick off an immediate fetch; the interval handles the rest.
      refresh();
    } else {
      // headers-source: show nothing until the next response arrives.
      clear();
    }
  }

  pi.on("model_select", (event) => {
    setActive(event.model.provider);
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  pi.on("session_start", async (_e, c) => {
    if (!c.hasUI) return;
    ctx = c;
    alive = true;
    setActive(c.model?.provider);
    const ms: number = (c as any).settings?.usageBlock?.refreshIntervalMs ?? 60_000;
    timer = setInterval(() => {
      if (alive) refresh();
    }, ms);
  });

  pi.on("session_shutdown", () => {
    alive = false;
    clearInterval(timer);
    timer = undefined;
    ctx = undefined;
    activeProviderId = undefined;
    headerWindows = undefined;
  });
}
