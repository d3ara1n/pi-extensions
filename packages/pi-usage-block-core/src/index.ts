/**
 * Shared data model + registry for usage/quota/balance providers.
 *
 * A provider registers as one of two kinds, discriminated by `kind`:
 * - **quota**:   usage consumed within a time window (e.g. 5h tokens quota).
 *                Returns one {@link QuotaWindow} per window; has a natural
 *                denominator (limit) so the display shows a percentage.
 * - **balance**: absolute remaining amount on an account (e.g. prepaid $32.50).
 *                No window, no reset — just an amount + currency.
 *
 * Each kind obtains its data one of two ways, set by `source` (orthogonal to
 * `kind` — any combination is valid):
 * - **api**:     `fetchUsage()` / `fetchBalance()` is polled periodically.
 * - **headers**: `parseHeaders()` is called on every provider response.
 *
 * Both kinds share an `id` that must match the pi provider key, so the status
 * bar can look up the right data for the currently active provider.
 */

/** Unit of measurement, shared by quota windows and balances. */
export type UsageUnit = "requests" | "tokens" | "dollars";

/** Response headers passed to `parseHeaders` (names are lower-cased). */
export type Headers = Record<string, string>;

/**
 * A single quota window (e.g. 5h tokens quota, weekly quota).
 *
 * Used by {@link QuotaProvider} of kind `"quota"`. `used` is always the
 * **consumed** amount — if a data source reports remaining, the provider
 * converts it (e.g. `used = limit - remaining`) before returning.
 */
export interface QuotaWindow {
  /** Time window label */
  period: string;
  /** Amount consumed (or percentage if limit=100) */
  used: number;
  /** Maximum allowed (use 100 for percentage-only data) */
  limit: number;
  /** Unit of measurement */
  unit: UsageUnit;
  /** When the quota resets; omit if unknown */
  resetAt?: Date;
}

/**
 * A prepaid balance on an account — an absolute remaining amount with no
 * time window and no automatic reset (it only changes when consumed or
 * topped up).
 *
 * Used by {@link BalanceProvider} of kind `"balance"`.
 */
export interface BalanceInfo {
  /** Remaining amount (e.g. 32.5) */
  amount: number;
  /** ISO 4217 currency code, e.g. "USD", "CNY". Drives symbol + thresholds in the display. */
  currency: string;
}

/**
 * A quota provider — usage consumed within time windows.
 */
export interface QuotaProvider {
  /** Discriminator — always `"quota"`. */
  kind: "quota";
  /** Unique identifier — must match the pi provider key, e.g. "zhipu-coding" */
  id: string;
  /** Display name, e.g. "Zhipu Coding Plan" */
  name: string;
  /** How usage is obtained. */
  source: "api" | "headers";
  /**
   * [source="api"] Fetch current quota windows. Called periodically by
   * pi-usage-block. Return empty array if unavailable (treated as offline).
   */
  fetchUsage?(): Promise<QuotaWindow[]>;
  /**
   * [source="headers"] Parse quota windows from a provider response's headers.
   * Called by pi-usage-block on every `after_provider_response`. Return null
   * when the response carries no usable data (the previous value is kept).
   * Header names are lower-cased.
   */
  parseHeaders?(headers: Headers): QuotaWindow[] | null;
}

/**
 * A balance provider — an absolute prepaid balance.
 */
export interface BalanceProvider {
  /** Discriminator — always `"balance"`. */
  kind: "balance";
  /** Unique identifier — must match the pi provider key */
  id: string;
  /** Display name */
  name: string;
  /** How the balance is obtained. */
  source: "api" | "headers";
  /**
   * [source="api"] Fetch the current balance. Called periodically by
   * pi-usage-block. Throw if unavailable (treated as offline; last value kept).
   */
  fetchBalance?(): Promise<BalanceInfo>;
  /**
   * [source="headers"] Parse the balance from a provider response's headers.
   * Called by pi-usage-block on every `after_provider_response`. Return null
   * when the response carries no usable data. Header names are lower-cased.
   */
  parseHeaders?(headers: Headers): BalanceInfo | null;
}

/** Any usage provider — discriminated by `kind`. */
export type UsageProvider = QuotaProvider | BalanceProvider;

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

/** Module-level singleton — shared via globalThis to survive jiti module dedup issues. */
const GLOBAL_KEY = Symbol.for("@d3ara1n/pi-usage-block-core/registry");

function createRegistry(): UsageRegistry {
  const reg = new UsageRegistry();
  (globalThis as any)[GLOBAL_KEY] = reg;
  return reg;
}

export const usageRegistry: UsageRegistry = (globalThis as any)[GLOBAL_KEY] ?? createRegistry();
