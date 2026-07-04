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

// ── Helpers ───────────────────────────────────────────────────────────────

/** Race a promise against a timeout (ms). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

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

/** Plain-text formatter for /usage command output (emoji instead of Nerd Font + theme). */
function fmtWindowPlain(w: UsageWindow): string {
  const ratio = w.limit > 0 && Number.isFinite(w.used) ? w.used / w.limit : 0;
  const icon = ratio >= 0.9 ? "🔴" : ratio >= 0.7 ? "🟡" : "🟢";
  let text = `${icon} ${fmtPct(w.used, w.limit)}`;
  if (w.resetAt) text += ` ↺${fmtCountdown(w.resetAt.getTime() - Date.now())}`;
  return text;
}

function fmtWindow(w: UsageWindow, theme: Theme): string {
  const ratio = w.limit > 0 && Number.isFinite(w.used) ? w.used / w.limit : 0;
  const level = ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "success";
  const icon = w.used === 0 ? "\ueabc" : "\uf111";
  let text = `${theme.fg(level, icon)}${theme.fg("dim", fmtPct(w.used, w.limit))}`;
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
  /** Cached windows per provider id (api: timer writes; headers: event writes). */
  const lastWindows = new Map<string, UsageWindow[]>();

  // ── Helpers ────────────────────────────────────────────────────────────

  function getActiveUsageProvider() {
    if (!activeProviderId) return undefined;
    return usageRegistry.get(activeProviderId);
  }

  /** Render the active provider's cached windows to the status bar. */
  function render() {
    if (!ctx || !alive || !activeProviderId) { clear(); return; }
    const windows = lastWindows.get(activeProviderId);
    if (!windows?.length) { clear(); return; }
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
      if (windows.length) lastWindows.set(provider.id, windows);
      render();
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
      lastWindows.set(provider.id, [w]);
      render();
    }
  });

  // ── Model tracking ─────────────────────────────────────────────────────

  function setActive(id: string | undefined) {
    activeProviderId = id;
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

  // ── /usage command ─────────────────────────────────────────────────────

  pi.registerCommand("usage", {
    description: "Show usage for all registered usage providers",
    handler: async (_args, cmdCtx) => {
      const providers = usageRegistry.getAll();
      if (!providers.length) {
        cmdCtx.ui.notify("No usage providers registered.", "info");
        return;
      }

      const activeId = activeProviderId;

      // Fetch fresh data from all api-source providers in parallel.
      const fetched = new Map<string, UsageWindow[]>();
      const fetches = providers
        .filter((p) => p.source === "api" && p.fetchUsage)
        .map(async (p) => {
          try {
            const windows = await withTimeout(p.fetchUsage!(), 5_000);
            fetched.set(p.id, windows);
            lastWindows.set(p.id, windows);
          } catch {
            // timeout or fetch error — fall back to cached
          }
        });

      await Promise.allSettled(fetches);

      // Build output
      const lines: string[] = ["**Usage — all providers**", ""];
      for (const p of providers) {
        const tag = p.id === activeId ? " *(active)*" : "";
        const sourceTag = ` (${p.source})`;
        const windows = fetched.get(p.id) ?? lastWindows.get(p.id);

        if (!windows?.length) {
          lines.push(`${p.name}${tag}${sourceTag}  —`);
          continue;
        }

        const parts = windows.map((w) => fmtWindowPlain(w));
        lines.push(`${p.name}${tag}${sourceTag}  ${parts.join(" ")}`);
      }

      cmdCtx.ui.notify(lines.join("\n"), "info");
    },
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
    lastWindows.clear();
  });
}
