/**
 * Built-in usage providers for pi's bundled LLM providers.
 *
 * Registered automatically by pi-usage-block on session_start for every
 * provider the user has configured (has an API key). A user-defined provider
 * with the same id always takes precedence — built-ins never overwrite it.
 *
 * Two kinds:
 * - headers (OpenAI / Anthropic / xAI / Cerebras / Together): parse rate-limit
 *   response headers. Each provider's reset format differs (Go duration,
 *   RFC 3339, epoch seconds, remaining seconds), which is exactly why parsing
 *   is per-provider code rather than a declarative mapping.
 * - balance (OpenRouter / DeepSeek): poll a prepaid balance endpoint using the
 *   provider's own API key (resolved via modelRegistry.getApiKeyForProvider).
 */
import type {
  UsageProvider,
  QuotaWindow,
  BalanceInfo,
  Headers,
} from "@d3ara1n/pi-usage-block-core";

// ── Header parsing helpers ────────────────────────────────────────────────

function num(h: Headers, key: string): number | undefined {
  const v = h[key];
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a Go duration string like "6m0s", "17ms", "1h30m". Returns seconds. */
function parseGoDuration(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  let total = 0;
  let found = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    found = true;
    const v = Number(m[1]);
    switch (m[2]) {
      case "ns": total += v / 1e9; break;
      case "us":
      case "µs": total += v / 1e6; break;
      case "ms": total += v / 1e3; break;
      case "s": total += v; break;
      case "m": total += v * 60; break;
      case "h": total += v * 3600; break;
    }
  }
  return found ? total : undefined;
}

function resetFromGoDuration(h: Headers, key: string): Date | undefined {
  const sec = parseGoDuration(h[key] ?? "");
  return sec !== undefined ? new Date(Date.now() + sec * 1000) : undefined;
}

function resetFromISO(h: Headers, key: string): Date | undefined {
  const s = h[key];
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Absolute Unix epoch seconds → Date. */
function resetFromEpochSec(h: Headers, key: string): Date | undefined {
  const n = num(h, key);
  return n !== undefined ? new Date(n * 1000) : undefined;
}

/** Remaining seconds from now → Date. */
function resetFromRemainingSec(h: Headers, key: string): Date | undefined {
  const n = num(h, key);
  return n !== undefined ? new Date(Date.now() + n * 1000) : undefined;
}

/** Build a single token quota window from limit/remaining headers. */
function tokenWindow(
  h: Headers,
  opts: { limit: string; remaining: string; period: string; reset?: Date },
): QuotaWindow[] | null {
  const limit = num(h, opts.limit);
  const remaining = num(h, opts.remaining);
  if (limit === undefined || remaining === undefined) return null;
  return [{
    period: opts.period,
    used: limit - remaining, // headers report remaining; QuotaWindow.used is consumed
    limit,
    unit: "tokens",
    resetAt: opts.reset,
  }];
}

// ── Per-provider header parsers ───────────────────────────────────────────
//
// OpenAI / xAI share the x-ratelimit-*-* names but differ in reset format:
// OpenAI sends a Go duration ("6m0s"), xAI an absolute Unix timestamp (sec).
// Anthropic uses an anthropic-ratelimit-* prefix and RFC 3339 timestamps.
// Cerebras adds -minute / -day suffixes and floating-point remaining seconds.
// Together uses an x-tokenlimit-* prefix with remaining seconds.

function openaiHeaders(h: Headers): QuotaWindow[] | null {
  return tokenWindow(h, {
    limit: "x-ratelimit-limit-tokens",
    remaining: "x-ratelimit-remaining-tokens",
    period: "TPM",
    reset: resetFromGoDuration(h, "x-ratelimit-reset-tokens"),
  });
}

function anthropicHeaders(h: Headers): QuotaWindow[] | null {
  return tokenWindow(h, {
    limit: "anthropic-ratelimit-tokens-limit",
    remaining: "anthropic-ratelimit-tokens-remaining",
    period: "tokens",
    reset: resetFromISO(h, "anthropic-ratelimit-tokens-reset"),
  });
}

function xaiHeaders(h: Headers): QuotaWindow[] | null {
  return tokenWindow(h, {
    limit: "x-ratelimit-limit-tokens",
    remaining: "x-ratelimit-remaining-tokens",
    period: "TPM",
    reset: resetFromEpochSec(h, "x-ratelimit-reset-tokens"),
  });
}

function cerebrasHeaders(h: Headers): QuotaWindow[] | null {
  return tokenWindow(h, {
    limit: "x-ratelimit-limit-tokens-minute",
    remaining: "x-ratelimit-remaining-tokens-minute",
    period: "min",
    reset: resetFromRemainingSec(h, "x-ratelimit-reset-tokens-minute"),
  });
}

function togetherHeaders(h: Headers): QuotaWindow[] | null {
  return tokenWindow(h, {
    limit: "x-tokenlimit-limit",
    remaining: "x-tokenlimit-remaining",
    period: "tokens",
    reset: resetFromRemainingSec(h, "x-tokenlimit-reset"),
  });
}

// ── Balance fetchers ──────────────────────────────────────────────────────

// Node's fetch (undici) ignores HTTP(S)_PROXY env vars by default. Honour them
// so balance requests reach providers behind a proxy (e.g. OpenRouter in CN).
let dispatcher: any;
async function getDispatcher(): Promise<any> {
  if (dispatcher !== undefined) return dispatcher;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
             || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) { dispatcher = null; return null; }
  try {
    const { ProxyAgent } = await import("undici");
    dispatcher = new ProxyAgent(proxy);
  } catch {
    dispatcher = null; // undici unavailable — fall back to direct
  }
  return dispatcher;
}

async function fetchJson(url: string, apiKey: string): Promise<any> {
  const d = await getDispatcher();
  const opts: any = { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } };
  if (d) opts.dispatcher = d;
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/** OpenRouter: GET /api/v1/credits → total_credits - total_usage (USD). */
async function openrouterBalance(apiKey: string): Promise<BalanceInfo> {
  const data = await fetchJson("https://openrouter.ai/api/v1/credits", apiKey);
  const total = data?.data?.total_credits;
  const used = data?.data?.total_usage;
  if (typeof total !== "number" || typeof used !== "number") throw new Error("credits unavailable");
  return { amount: total - used, currency: "USD" };
}

/** DeepSeek: GET /user/balance → balance_infos[0].total_balance (currency from API). */
async function deepseekBalance(apiKey: string): Promise<BalanceInfo> {
  const data = await fetchJson("https://api.deepseek.com/user/balance", apiKey);
  const info = data?.balance_infos?.[0];
  const amount = info ? Number(info.total_balance) : NaN;
  if (!Number.isFinite(amount)) throw new Error("balance unavailable");
  const currency = typeof info?.currency === "string" ? info.currency : "USD";
  return { amount, currency };
}

/** OpenCode Go: GET /zen/go/v1/usage → rolling5h + weekly + monthly quota windows (dollars). */
async function opencodeGoUsage(apiKey: string): Promise<QuotaWindow[]> {
  const data = await fetchJson("https://opencode.ai/zen/go/v1/usage", apiKey);
  const windows: QuotaWindow[] = [];
  for (const [key, label] of [["rolling5h", "5h"], ["weekly", "weekly"], ["monthly", "monthly"]] as const) {
    const w = data?.[key];
    if (!w) continue;
    const used = Number(w.usageDollars);
    const limit = Number(w.limitDollars);
    if (!Number.isFinite(used) || !Number.isFinite(limit)) continue;
    const resetInSec = Number(w.resetInSec);
    windows.push({
      period: label,
      used,
      limit,
      unit: "dollars",
      resetAt: Number.isFinite(resetInSec) && resetInSec > 0 ? new Date(Date.now() + resetInSec * 1000) : undefined,
    });
  }
  return windows;
}

// ── Registry of built-in definitions ──────────────────────────────────────

export interface BuiltinContext {
  apiKey: string;
  modelRegistry: any;
}

export interface BuiltinDef {
  /** Must match a pi provider key (e.g. "openai"). */
  id: string;
  build: (ctx: BuiltinContext) => UsageProvider;
}

export const BUILTIN_PROVIDERS: BuiltinDef[] = [
  {
    id: "openai",
    build: () => ({
      kind: "quota", id: "openai", name: "OpenAI", source: "headers",
      parseHeaders: openaiHeaders,
    }),
  },
  {
    id: "anthropic",
    build: () => ({
      kind: "quota", id: "anthropic", name: "Anthropic", source: "headers",
      parseHeaders: anthropicHeaders,
    }),
  },
  {
    id: "xai",
    build: () => ({
      kind: "quota", id: "xai", name: "xAI", source: "headers",
      parseHeaders: xaiHeaders,
    }),
  },
  {
    id: "cerebras",
    build: () => ({
      kind: "quota", id: "cerebras", name: "Cerebras", source: "headers",
      parseHeaders: cerebrasHeaders,
    }),
  },
  {
    id: "together",
    build: () => ({
      kind: "quota", id: "together", name: "Together", source: "headers",
      parseHeaders: togetherHeaders,
    }),
  },
  {
    id: "openrouter",
    build: ({ apiKey }) => ({
      kind: "balance", id: "openrouter", name: "OpenRouter", source: "api",
      fetchBalance: () => openrouterBalance(apiKey),
    }),
  },
  {
    id: "deepseek",
    build: ({ apiKey }) => ({
      kind: "balance", id: "deepseek", name: "DeepSeek", source: "api",
      fetchBalance: () => deepseekBalance(apiKey),
    }),
  },
  {
    id: "opencode-go",
    build: ({ apiKey }) => ({
      kind: "quota", id: "opencode-go", name: "OpenCode Go", source: "api",
      fetchUsage: () => opencodeGoUsage(apiKey),
    }),
  },
];
