/**
 * pi-usage-block — Status bar display
 *
 * Displays usage for the currently active pi provider. Providers register as
 * one of two kinds (see @d3ara1n/pi-usage-block-core):
 *   quota:   consumed/limit per time window → percentage + countdown
 *   balance: absolute remaining amount      → amount, coloured by thresholds
 *
 * Polling (source "api") runs on a timer for both kinds (fetchUsage /
 * fetchBalance). Providers of source "headers" are instead updated on every
 * response via after_provider_response + parseHeaders.
 *
 * Optional settings under "usageBlock":
 *   refreshIntervalMs — poll interval in ms for api/balance providers (default 60000)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  usageRegistry,
  type QuotaWindow,
  type BalanceInfo,
  type UsageProvider,
} from "@d3ara1n/pi-usage-block-core";
import { BUILTIN_PROVIDERS } from "./builtin";

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

/** Short error message for status display. */
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || "error";
  return String(e);
}

// Nerd Font nf-fa-circle (U+F111) — single glyph, colored per severity via theme.
type Theme = { fg(color: string, text: string): string };

// ── Severity thresholds (display strategy — not part of the data model) ──
//
// Colour is a presentation concern, so thresholds live here in the display
// layer, never on the provider/data model. Centralised as constants so that
// future per-provider settings can override them in one place without
// touching formatters or core.

type Level = "success" | "warning" | "error";

/** Quota thresholds on the used/limit ratio. */
const QUOTA_THRESHOLDS = { warning: 0.7, error: 0.9 };

/** Currency → symbol. Unknown currencies fall back to "<code> ". */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  CNY: "¥",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

/**
 * Balance thresholds on the absolute amount, per currency. Defaults used when
 * settings do not override them; unknown currencies fall back to USD.
 */
const DEFAULT_BALANCE_THRESHOLDS: Record<string, { warning: number; error: number }> = {
  USD: { warning: 25, error: 5 },
  CNY: { warning: 175, error: 35 },
};

function quotaLevel(ratio: number): Level {
  return ratio >= QUOTA_THRESHOLDS.error ? "error"
       : ratio >= QUOTA_THRESHOLDS.warning ? "warning" : "success";
}

function balanceLevel(amount: number, currency: string): Level {
  const t = DEFAULT_BALANCE_THRESHOLDS[currency] ?? DEFAULT_BALANCE_THRESHOLDS.USD;
  return amount < t.error ? "error" : amount < t.warning ? "warning" : "success";
}

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
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d${rh}h` : `${d}d`;
}

function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}

function fmtBalanceAmount(amount: number, currency: string): string {
  return `${currencySymbol(currency)}${amount.toFixed(2)}`;
}

// ── Plain-text formatters (for /usage command: emoji instead of Nerd Font) ─

function levelEmoji(lvl: Level): string {
  return lvl === "error" ? "🔴" : lvl === "warning" ? "🟡" : "🟢";
}

function fmtWindowPlain(w: QuotaWindow): string {
  const ratio = w.limit > 0 && Number.isFinite(w.used) ? w.used / w.limit : 0;
  let text = `${levelEmoji(quotaLevel(ratio))} ${fmtPct(w.used, w.limit)}`;
  if (w.resetAt) text += ` ↺${fmtCountdown(w.resetAt.getTime() - Date.now())}`;
  return text;
}

function fmtBalancePlain(info: BalanceInfo): string {
  return `${levelEmoji(balanceLevel(info.amount, info.currency))} ${fmtBalanceAmount(info.amount, info.currency)}`;
}

// ── Nerd Font + theme formatters (for the status bar) ────────────────────

function fmtWindow(w: QuotaWindow, theme: Theme): string {
  const ratio = w.limit > 0 && Number.isFinite(w.used) ? w.used / w.limit : 0;
  const level = quotaLevel(ratio);
  const icon = w.used === 0 ? "\ueabc" : "\uf111";
  let text = `${theme.fg(level, icon)}${theme.fg("dim", fmtPct(w.used, w.limit))}`;
  if (w.resetAt) text += theme.fg("dim", ` ↺${fmtCountdown(w.resetAt.getTime() - Date.now())}`);
  return text;
}

function fmtBalance(info: BalanceInfo, theme: Theme): string {
  const level = balanceLevel(info.amount, info.currency);
  // The amount + currency symbol already carry the colour; no icon needed
  // (unlike quota, where only the icon is coloured and the percentage is dim).
  return theme.fg(level, fmtBalanceAmount(info.amount, info.currency));
}

function fmtProviderQuota(name: string, windows: QuotaWindow[], theme: Theme): string {
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
  /** Cached quota windows per provider id (api: timer writes; headers: event writes). */
  const lastWindows = new Map<string, QuotaWindow[]>();
  /** Cached balance per provider id (api: timer; headers: event). */
  const lastBalance = new Map<string, BalanceInfo>();
  /** ids of built-in providers registered this session (unregistered on shutdown). */
  const registeredBuiltins: string[] = [];
  /** Last fetch error per provider id (shown in the status bar until next success). */
  const lastError = new Map<string, string>();

  // ── Helpers ────────────────────────────────────────────────────────────

  function getActiveUsageProvider(): UsageProvider | undefined {
    if (!activeProviderId) return undefined;
    return usageRegistry.get(activeProviderId);
  }

  /** Render the active provider's cached data to the status bar. */
  function render() {
    if (!ctx || !alive || !activeProviderId) { clear(); return; }
    const provider = getActiveUsageProvider();
    if (!provider) { clear(); return; }
    const theme = ctx.ui.theme;

    const err = lastError.get(provider.id);
    if (err) {
      ctx.ui.setStatus(STATUS_KEY, `${theme.fg("dim", provider.name)} ${theme.fg("warning", err)}`);
      return;
    }

    if (provider.kind === "balance") {
      const info = lastBalance.get(provider.id);
      if (!info) { clear(); return; }
      ctx.ui.setStatus(STATUS_KEY, `${theme.fg("dim", provider.name)} ${fmtBalance(info, theme)}`);
      return;
    }

    // quota
    const windows = lastWindows.get(provider.id);
    if (!windows?.length) { clear(); return; }
    ctx.ui.setStatus(STATUS_KEY, fmtProviderQuota(provider.name, windows, theme));
  }

  /** Remove the status bar entry. */
  function clear() {
    if (!ctx || !alive) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  // ── Refresh (timer-driven; serves both kinds) ──────────────────────────

  async function refresh() {
    if (!ctx || !alive) return;
    const provider = getActiveUsageProvider();
    if (!provider || provider.source !== "api") return; // headers source靠事件
    render(); // show cached state immediately (e.g. right after a model switch)
    try {
      if (provider.kind === "balance") {
        if (!provider.fetchBalance) return;
        const info = await withTimeout(provider.fetchBalance(), 5_000);
        if (!ctx || !alive) return;
        lastBalance.set(provider.id, info);
        lastError.delete(provider.id);
      } else {
        // quota, api
        if (!provider.fetchUsage) return;
        const windows = await withTimeout(provider.fetchUsage(), 5_000);
        if (!ctx || !alive) return;
        if (windows.length) lastWindows.set(provider.id, windows);
        lastError.delete(provider.id);
      }
      render();
    } catch (e) {
      if (!ctx || !alive) return;
      lastError.set(provider.id, errMsg(e));
      render();
    }
  }

  // ── Headers-source handling (event-driven, both kinds) ────────────────

  pi.on("after_provider_response", (event) => {
    if (!alive) return;
    const provider = getActiveUsageProvider();
    if (!provider || provider.source !== "headers" || !provider.parseHeaders) return;
    // Parse inside the kind branch so the return type narrows correctly.
    if (provider.kind === "balance") {
      const info = provider.parseHeaders(event.headers);
      if (info) { lastBalance.set(provider.id, info); render(); }
    } else {
      const windows = provider.parseHeaders(event.headers);
      if (windows) { lastWindows.set(provider.id, windows); render(); }
    }
  });

  // ── Model tracking ─────────────────────────────────────────────────────

  function setActive(id: string | undefined) {
    activeProviderId = id;
    const provider = getActiveUsageProvider();
    if (!provider) { clear(); return; }
    // api providers (quota or balance) kick off an immediate fetch; headers
    // providers show nothing until the next response arrives.
    if (provider.source === "api") {
      refresh();
    } else {
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

      // Fetch fresh data from all pollable providers in parallel.
      const fetchedWindows = new Map<string, QuotaWindow[]>();
      const fetchedBalance = new Map<string, BalanceInfo>();
      const fetchErrors = new Map<string, string>();
      const fetches = providers.map(async (p) => {
        if (p.source !== "api") return; // headers providers: show cached value
        try {
          if (p.kind === "balance" && p.fetchBalance) {
            const info = await withTimeout(p.fetchBalance(), 5_000);
            fetchedBalance.set(p.id, info);
            lastBalance.set(p.id, info);
            lastError.delete(p.id);
          } else if (p.kind === "quota" && p.fetchUsage) {
            const windows = await withTimeout(p.fetchUsage(), 5_000);
            fetchedWindows.set(p.id, windows);
            lastWindows.set(p.id, windows);
            lastError.delete(p.id);
          }
        } catch (e) {
          fetchErrors.set(p.id, errMsg(e));
        }
      });

      await Promise.allSettled(fetches);

      // Build output
      const lines: string[] = ["**Usage — all providers**", ""];
      for (const p of providers) {
        const tag = p.id === activeId ? " *(active)*" : "";
        const sourceTag = ` (${p.source})`;

        if (p.kind === "balance") {
          const info = fetchedBalance.get(p.id) ?? lastBalance.get(p.id);
          if (!info) {
            const err = fetchErrors.get(p.id) ?? lastError.get(p.id);
            lines.push(`${p.name}${tag}${sourceTag}  ${err ? `⚠ ${err}` : "—"}`);
            continue;
          }
          lines.push(`${p.name}${tag}${sourceTag}  ${fmtBalancePlain(info)}`);
          continue;
        }

        // quota
        const windows = fetchedWindows.get(p.id) ?? lastWindows.get(p.id);
        if (!windows?.length) {
          const err = fetchErrors.get(p.id) ?? lastError.get(p.id);
          lines.push(`${p.name}${tag}${sourceTag}  ${err ? `⚠ ${err}` : "—"}`);
          continue;
        }
        const parts = windows.map((w) => fmtWindowPlain(w));
        lines.push(`${p.name}${tag}${sourceTag}  ${parts.join(" ")}`);
      }

      cmdCtx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Built-in providers ─────────────────────────────────────────────────
  /** Register built-in usage providers for every pi provider the user has
   *  configured (has an API key). User-defined providers take precedence. */
  async function registerBuiltins(c: any) {
    const mr = c?.modelRegistry;
    for (const def of BUILTIN_PROVIDERS) {
      if (usageRegistry.get(def.id)) continue; // user-defined — don't override
      let apiKey: string | undefined;
      try {
        apiKey = await mr?.getApiKeyForProvider?.(def.id);
      } catch {
        // provider not configured or unknown — skip
      }
      if (!apiKey) continue;
      try {
        usageRegistry.register(def.build({ apiKey, modelRegistry: mr }));
        registeredBuiltins.push(def.id);
      } catch {
        // build failed — skip
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  pi.on("session_start", async (_e, c) => {
    if (!c.hasUI) return;
    ctx = c;
    alive = true;
    await registerBuiltins(c);
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
    lastBalance.clear();
    lastError.clear();
    for (const id of registeredBuiltins) usageRegistry.unregister(id);
    registeredBuiltins.length = 0;
  });
}
