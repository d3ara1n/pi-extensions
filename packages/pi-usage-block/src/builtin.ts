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
 * - api polling — using the provider's own API key or OAuth token (resolved via
 *   the built-in provider context):
 *   - quota (OpenAI Codex): ChatGPT Codex subscription usage endpoint
 *   - balance (OpenRouter / DeepSeek): prepaid account balance endpoint
 *   - quota (OpenCode Go, Z.AI / Z.AI Coding CN): coding-plan quota endpoint
 *   - quota (Kimi For Coding): coding-plan usage endpoint
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

function jsonNum(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Extract the ChatGPT account id required by the Codex backend from its OAuth JWT. */
function codexAccountId(token: string): string {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) throw new Error("missing JWT payload");
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");
    const payload = JSON.parse(atob(base64));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error("missing account id");
    return accountId;
  } catch {
    throw new Error("invalid OpenAI Codex OAuth token");
  }
}

function codexWindow(value: any, period: string): QuotaWindow | undefined {
  const used = jsonNum(value?.used_percent);
  if (used === undefined) return undefined;
  const reset = jsonNum(value?.reset_at);
  return {
    period,
    used,
    limit: 100,
    unit: "tokens",
    resetAt: reset !== undefined ? new Date(reset * 1000) : undefined,
  };
}

/**
 * ChatGPT Codex subscription quota from the undocumented wham usage endpoint.
 * The OAuth token is resolved on every poll so Pi can refresh it after expiry.
 */
async function openaiCodexUsage(
  resolveApiKey: () => Promise<string | undefined>,
): Promise<QuotaWindow[]> {
  const token = await resolveApiKey();
  if (!token) throw new Error("OpenAI Codex OAuth unavailable");
  const accountId = codexAccountId(token);
  const data = await fetchJson(
    "https://chatgpt.com/backend-api/wham/usage",
    token,
    "bearer",
    { "ChatGPT-Account-Id": accountId },
  );
  const rateLimit = data?.rate_limit ?? data?.rateLimit;
  if (!rateLimit) return [];
  return [
    codexWindow(rateLimit.primary_window ?? rateLimit.primaryWindow, "primary"),
    codexWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow, "secondary"),
  ].filter((window): window is QuotaWindow => window !== undefined);
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

/**
 * Fetch JSON from a provider endpoint.
 * `auth: "raw"` sends the API key verbatim (no `Bearer ` prefix) — needed by
 * Zhipu/Z.AI's internal monitor API, which is not a standard OpenAI-style
 * endpoint and rejects Bearer auth.
 */
async function fetchJson(
  url: string,
  apiKey: string,
  auth: "bearer" | "raw" = "bearer",
  extraHeaders?: Record<string, string>,
): Promise<any> {
  const d = await getDispatcher();
  const opts: any = {
    headers: {
      Authorization: auth === "raw" ? apiKey : `Bearer ${apiKey}`,
      Accept: "application/json",
      ...extraHeaders,
    },
  };
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

/**
 * OpenCode Go: GET /zen/go/v1/usage → rolling (5h) + weekly + monthly quota
 * windows, each reported as a consumed percentage (0–100, 100 = rate-limited).
 *
 * Response shape (verified live against opencode.ai, 2026-08):
 *   { "usage": { "rolling":  { "status": "ok", "percent": 0,  "resetsAt": "<ISO>" },
 *                "weekly":   { "status": "ok", "percent": 0,  "resetsAt": "<ISO>" },
 *                "monthly":  { "status": "ok", "percent": 88, "resetsAt": "<ISO>" } } }
 * The endpoint returns no absolute amounts — only percentages — so used/limit
 * are mapped to percent/100 and every window with a numeric percent is shown
 * (100 included).
 */
async function opencodeGoUsage(apiKey: string): Promise<QuotaWindow[]> {
  const data = await fetchJson("https://opencode.ai/zen/go/v1/usage", apiKey);
  const windows: QuotaWindow[] = [];
  for (const [key, label] of [["rolling", "5h"], ["weekly", "weekly"], ["monthly", "monthly"]] as const) {
    const w = data?.usage?.[key];
    if (!w) continue;
    const percent = Number(w.percent);
    if (!Number.isFinite(percent)) continue;
    windows.push({
      period: label,
      used: percent,
      limit: 100,
      unit: "dollars",
      resetAt: typeof w.resetsAt === "string" ? new Date(w.resetsAt) : undefined,
    });
  }
  return windows;
}

/**
 * Zhipu / Z.AI coding plan: GET {host}/api/monitor/usage/quota/limit.
 *
 * Polls the subscription-UI's internal quota endpoint (undocumented but
 * stable; used by z.ai/bigmodel.cn's own dashboards). Returns one
 * {@link QuotaWindow} per TOKENS_LIMIT — a 5h rolling window, and on Pro
 * plans a weekly one too. `percentage` is consumed-as-% (so limit=100);
 * `nextResetTime` is epoch milliseconds. Auth is the raw API key.
 *
 * `host` is `https://api.z.ai` (international, provider "zai") or
 * `https://open.bigmodel.cn` (China mainland, provider "zai-coding-cn").
 */
async function zhipuCodingQuota(host: string, apiKey: string): Promise<QuotaWindow[]> {
  const data = await fetchJson(`${host}/api/monitor/usage/quota/limit`, apiKey, "raw");
  const limits = data?.data?.limits;
  if (!Array.isArray(limits)) return [];
  return limits
    .filter((l: any) => l?.type === "TOKENS_LIMIT" && typeof l.percentage === "number")
    .map((l: any) => ({
      // unit 3 = hours (5h window); weekly windows use a different unit.
      period: l.number && l.unit ? `${l.number}${l.unit === 3 ? "h" : "w"}` : "",
      used: l.percentage,
      limit: 100,
      unit: "tokens" as const,
      resetAt: l.nextResetTime ? new Date(l.nextResetTime) : undefined,
    }));
}

// ── Kimi For Coding ───────────────────────────────────────────────────────

/**
 * timeUnit → minutes multiplier, keyed by the bare unit. The endpoint sends
 * the proto-style `TIME_UNIT_MINUTE`; the official CLI's own fixtures use the
 * bare `MINUTE`, so both spellings (any case) are accepted.
 * Units outside this table yield no window at all.
 *
 * `MONTH` counts as 30 days: the duration is only a sort/dedupe key and the
 * basis for the period label, so the calendar-month imprecision is harmless.
 */
const KIMI_TIME_UNIT_MINUTES: Record<string, number> = {
  MINUTE: 1,
  HOUR: 60,
  DAY: 1440,
  WEEK: 10080,
  MONTH: 43200,
};

/** Non-negative integer, arriving as a decimal string or a number. */
function kimiInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

/** Minutes multiplier for a limits[] item's `window.timeUnit`. */
function kimiTimeUnitMultiplier(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  return KIMI_TIME_UNIT_MINUTES[raw.trim().toUpperCase().replace(/^TIME_UNIT_/, "")];
}

/** Rolling-window minutes from a limits[] item's proto-style `window`. */
function kimiWindowMinutes(item: any): number | undefined {
  const duration = kimiInt(item?.window?.duration);
  const multiplier = kimiTimeUnitMultiplier(item?.window?.timeUnit);
  if (duration === undefined || duration === 0 || multiplier === undefined) return undefined;
  return duration * multiplier;
}

/** Short period label: "5h", "daily", "weekly", "monthly", … */
function kimiPeriodLabel(minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 1440) return "daily";
  if (minutes === 10080) return "weekly";
  if (minutes === 43200) return "monthly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** The row's reset timestamp, under any of the spellings the endpoint uses. */
function kimiResetAt(detail: any): Date | undefined {
  for (const key of ["resetTime", "resetAt", "reset_time", "reset_at"]) {
    const value = detail?.[key];
    if (typeof value !== "string") continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

/** One usage row (`detail`) → QuotaWindow. Skips rows without usable counts. */
function kimiRow(detail: any, period: string): QuotaWindow | undefined {
  const limit = kimiInt(detail?.limit);
  // Some payloads report only `remaining`; QuotaWindow.used is consumed.
  let used = kimiInt(detail?.used);
  if (used === undefined && limit !== undefined) {
    const remaining = kimiInt(detail?.remaining);
    if (remaining !== undefined) used = limit - remaining;
  }
  if (used === undefined || limit === undefined || limit === 0) return undefined;
  return {
    period,
    used,
    limit,
    unit: "requests", // plan usage counts — the endpoint exposes no finer unit
    resetAt: kimiResetAt(detail),
  };
}

/**
 * Parse the Kimi usage payload into windows keyed by rolling duration.
 *
 * `usage` is the plan's weekly summary (the backend omits its window);
 * `limits[]` carries per-window rows (the 5-hour limit arrives as duration
 * 300 TIME_UNIT_MINUTE). Counts arrive as decimal strings or numbers, and
 * some payloads report `remaining` instead of `used`. Duplicate windows
 * collapse to one (summary wins), rows sort shortest window first.
 *
 * Window types map to the 5h / daily / weekly / monthly rows; a unit outside
 * {@link KIMI_TIME_UNIT_MINUTES} yields no row. The optional `boosterWallet`
 * (prepaid balance) is likewise not mapped — a balance does not fit the
 * quota-window display.
 */
function parseKimiUsage(data: any): QuotaWindow[] {
  const byWindow = new Map<number, QuotaWindow>();
  const summary = kimiRow(data?.usage, "weekly");
  if (summary) byWindow.set(10080, summary);
  for (const item of Array.isArray(data?.limits) ? data.limits : []) {
    const minutes = kimiWindowMinutes(item);
    if (minutes === undefined || byWindow.has(minutes)) continue;
    const row = kimiRow(item?.detail, kimiPeriodLabel(minutes));
    if (row) byWindow.set(minutes, row);
  }
  return [...byWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, w]) => w);
}

/**
 * Kimi For Coding: GET https://api.kimi.com/coding/v1/usages.
 *
 * The managed usage endpoint the official kimi-code CLI reads. The OAuth
 * token (when pi resolves one instead of an API key) is re-resolved on every
 * poll so short-lived tokens refresh after expiry.
 */
async function kimiCodingUsage(apiKey: string): Promise<QuotaWindow[]> {
  const data = await fetchJson("https://api.kimi.com/coding/v1/usages", apiKey);
  return parseKimiUsage(data);
}

// ── Registry of built-in definitions ──────────────────────────────────────

export interface BuiltinContext {
  apiKey: string;
  resolveApiKey: () => Promise<string | undefined>;
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
    id: "openai-codex",
    build: ({ resolveApiKey }) => ({
      kind: "quota", id: "openai-codex", name: "OpenAI Codex", source: "api",
      fetchUsage: () => openaiCodexUsage(resolveApiKey),
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
  {
    id: "zai",
    build: ({ apiKey }) => ({
      kind: "quota", id: "zai", name: "Z.AI", source: "api",
      fetchUsage: () => zhipuCodingQuota("https://api.z.ai", apiKey),
    }),
  },
  {
    id: "zai-coding-cn",
    build: ({ apiKey }) => ({
      kind: "quota", id: "zai-coding-cn", name: "Z.AI Coding CN", source: "api",
      fetchUsage: () => zhipuCodingQuota("https://open.bigmodel.cn", apiKey),
    }),
  },
  {
    id: "kimi-coding",
    build: ({ resolveApiKey }) => ({
      kind: "quota", id: "kimi-coding", name: "Kimi For Coding", source: "api",
      fetchUsage: async () => {
        const key = await resolveApiKey();
        if (!key) throw new Error("Kimi Coding credential unavailable");
        return kimiCodingUsage(key);
      },
    }),
  },
];
