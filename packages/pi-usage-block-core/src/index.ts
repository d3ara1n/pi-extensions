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
 * A usage provider registered by a provider plugin.
 * Each provider is responsible for fetching its own usage data.
 */
export interface UsageProvider {
  /** Unique identifier, e.g. "zhipu-coding" */
  id: string;
  /** Display name, e.g. "Zhipu Coding Plan" */
  name: string;
  /** Optional icon character */
  icon?: string;
  /**
   * Fetch current usage windows.
   * Should return one entry per window type the provider tracks.
   * Return empty array if unavailable (provider is treated as offline).
   */
  fetchUsage(): Promise<UsageWindow[]>;
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

/** Module-level singleton — shared via globalThis to survive jiti module dedup issues. */
const GLOBAL_KEY = Symbol.for("@d3ara1n/pi-usage-block-core/registry");

function createRegistry(): UsageRegistry {
  const reg = new UsageRegistry();
  (globalThis as any)[GLOBAL_KEY] = reg;
  return reg;
}

export const usageRegistry: UsageRegistry =
  (globalThis as any)[GLOBAL_KEY] ?? createRegistry();
