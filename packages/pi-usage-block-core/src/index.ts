/**
 * A single usage window (e.g. 5h quota, weekly quota).
 */
export interface UsageWindow {
  /** Time window label */
  period: string;
  /** Amount consumed (or percentage if limit=100) */
  used: number;
  /** Maximum allowed (use 100 for percentage-only data) */
  limit: number;
  /** Unit of measurement */
  unit: "requests" | "tokens" | "dollars";
  /** When the quota resets; omit if unknown */
  resetAt?: Date;
}

/**
 * Header mapping for reading usage from response headers (source: "headers").
 * Maps header name → UsageWindow field.
 *
 * Supported field keys: "used", "limit", "period", "unit", "resetAt"
 * - "used" and "limit" are parsed as numbers
 * - "unit" should be "requests" | "tokens" | "dollars"
 * - "resetAt" is parsed as epoch-seconds or ISO 8601
 * - "period" is a free-text label
 *
 * Example:
 *   { "x-ratelimit-remaining-tokens": "used",
 *     "x-ratelimit-limit-tokens": "limit",
 *     "x-ratelimit-reset-requests": "resetAt" }
 */
export interface HeaderMapping {
  [headerName: string]: "used" | "limit" | "period" | "unit" | "resetAt";
}

/**
 * A usage provider registered by a provider plugin.
 *
 * Two modes are supported:
 * - **api**: `fetchUsage()` is called periodically by pi-usage-block.
 * - **headers**: usage is extracted from HTTP response headers.
 *   pi-usage-block listens to `after_provider_response` and applies `headerMapping`.
 *   No code required — just declare the mapping.
 */
export interface UsageProvider {
  /** Unique identifier — must match the pi provider key, e.g. "zhipu-coding" */
  id: string;
  /** Display name, e.g. "Zhipu Coding Plan" */
  name: string;
  /** Optional icon character */
  icon?: string;
  /**
   * Data source type.
   * - "api": fetch usage via an external API (requires `fetchUsage`)
   * - "headers": read usage from per-response HTTP headers (requires `headerMapping`)
   */
  source: "api" | "headers";
  /**
   * [source="api"] Fetch current usage windows.
   * Called periodically by pi-usage-block.
   * Return empty array if unavailable (provider is treated as offline).
   */
  fetchUsage?(): Promise<UsageWindow[]>;
  /**
   * [source="headers"] Map response header names to UsageWindow fields.
   * pi-usage-block reads `after_provider_response` event headers,
   * builds a single UsageWindow from the mapping.
   */
  headerMapping?: HeaderMapping;
}

/**
 * Global singleton registry for usage providers.
 *
 * Shared across all pi extensions via the npm package —
 * because pi loads all extensions from the same node_modules tree,
 * the module-level instance is naturally shared.
 */
export class UsageRegistry {
  private providers = new Map<string, UsageProvider>();

  /** Register a usage provider. Overwrites if id already exists. */
  register(provider: UsageProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Remove a previously registered provider. */
  unregister(id: string): void {
    this.providers.delete(id);
  }

  /** Get all registered providers. */
  getAll(): UsageProvider[] {
    return [...this.providers.values()];
  }

  /** Get a specific provider by id. */
  get(id: string): UsageProvider | undefined {
    return this.providers.get(id);
  }

  /** Check if any providers are registered. */
  get size(): number {
    return this.providers.size;
  }
}

/** Helper: parse a UsageWindow from response headers using a HeaderMapping. */
export function parseHeaderUsage(
  headers: Record<string, string>,
  mapping: HeaderMapping,
): UsageWindow | null {
  const fields: Partial<UsageWindow> = {};
  for (const [headerName, fieldKey] of Object.entries(mapping)) {
    const value = headers[headerName] ?? headers[headerName.toLowerCase()];
    if (value === undefined) continue;
    switch (fieldKey) {
      case "used":
      case "limit":
        fields[fieldKey] = Number(value);
        break;
      case "period":
        fields.period = value;
        break;
      case "unit":
        if (value === "requests" || value === "tokens" || value === "dollars") {
          fields.unit = value;
        }
        break;
      case "resetAt": {
        const n = Number(value);
        fields.resetAt = new Date(Number.isFinite(n) && n > 1e12 ? n : n * 1000);
        break;
      }
    }
  }
  // Must have at least used and limit, or percentage
  if (fields.used === undefined && fields.limit === undefined) return null;
  return {
    period: fields.period ?? "",
    used: fields.used ?? 0,
    limit: fields.limit ?? 100,
    unit: fields.unit ?? "tokens",
    resetAt: fields.resetAt,
  };
}

/** Module-level singleton — shared via globalThis to survive jiti module dedup issues. */
const GLOBAL_KEY = Symbol.for("@d3ara1n/pi-usage-block-core/registry");

function createRegistry(): UsageRegistry {
  const reg = new UsageRegistry();
  (globalThis as any)[GLOBAL_KEY] = reg;
  return reg;
}

export const usageRegistry: UsageRegistry =
  (globalThis as any)[GLOBAL_KEY] ?? createRegistry();
