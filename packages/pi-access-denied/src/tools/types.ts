/** A path a tool call appears to reach, with optional display context. */
export interface ExtractedTarget {
  /** Absolute path spelling or symbolic named home; no filesystem resolution. */
  path: string;
  /** Command or patch header that produced this path. */
  source?: string;
  /** Known branch conditions associated with this path. */
  condition?: string;
  /** The operand has multiple possible locations or remains partly unresolved. */
  estimate?: boolean;
}

/** Tool-specific input interpretation; access decisions belong to the shared gate. */
export interface ToolAdapter {
  label?: string;
  action?: string;
  extract(input: Record<string, unknown>, cwd: string): ExtractedTarget[];
}
