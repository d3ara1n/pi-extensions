/**
 * PathManager — the single authority over path access decisions.
 *
 * All rules live here and are resolved by ONE algorithm: longest-prefix-match.
 * The most specific (deepest) rule covering a target wins, regardless of which
 * layer it came from. A same-depth allow/deny conflict resolves to deny.
 *
 * Three rule layers exist, but layering is ONLY for display (the
 * `/access-denied status` command groups rules by source). At decision time
 * every rule is an equal peer in the match — config, session, and builtin are
 * indistinguishable to the algorithm. This is deliberate: it means a runtime
 * "always-allow /a/b/c" correctly overrides a config "deny /a/b" because it is
 * strictly more specific, exactly as two config rules would interact.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ builtin  /dev/null, /dev/fd/, /tmp, os.tmpdir() …   (allow)      │
 *   │ config   cwd + allowedPaths (allow) · deniedPaths (deny+reason)  │
 *   │ session  panel always-allow / always-deny (deny+reason)          │
 *   └──────────────────────────────────────────────────────────────────┘
 *                          ↓ longest-prefix-match ↓
 *                       decide(target) → allow | deny | outside
 *
 * `outside` means "no allow rule covers the target" — it is not a deny, it is
 * "uncovered, needs authorization", and the mode logic (prompt/deny/allow) in
 * index.ts decides what to do with it.
 *
 * This collapses the old scattered checks (isSafe → buildAllowlist →
 * isOutsideAllowlist → session caches) into a single decide() entry point, so
 * the policy can never diverge between layers.
 */

import { builtinSafeRoots, isWinDeviceName, resolveTarget, toPosix, underRoot } from "./paths.ts";

/** Where a rule originated — used only for `/access-denied status` grouping. */
export type RuleSource = "builtin" | "config" | "session";

/** A single allow/deny rule covering a path and everything beneath it. */
export interface Rule {
  /** POSIX-normalized absolute path; covers itself + all descendants. */
  path: string;
  decision: "allow" | "deny";
  /** Deny-only: an optional reason surfaced to the agent as a "user note". */
  reason?: string;
  source: RuleSource;
}

export type DecisionKind = "allow" | "deny" | "outside";

/**
 * The result of deciding a single target path.
 *   - allow   → in-bounds, passthrough
 *   - deny    → an explicit deny rule matched; `reason` present if it carried one
 *   - outside → no allow rule covers it; needs authorization (mode logic applies)
 */
export interface Decision {
  kind: DecisionKind;
  reason?: string;
}

/** Count non-empty path segments for the "most specific wins" depth comparison. "/a/b/c" → 3, "/" → 0. */
function segmentDepth(p: string): number {
  return p.split("/").filter(Boolean).length;
}

export class PathManager {
  private builtinRules: Rule[] = [];
  private configRules: Rule[] = [];
  private sessionRules: Rule[] = [];

  /**
   * @param cwd           Session working directory (always an allow root).
   * @param allowedPaths  Config `allowedPaths` (home-relative/absolute allow roots).
   * @param deniedPaths   Config `deniedPaths` (path → reason|null deny rules).
   */
  constructor(cwd: string, allowedPaths: string[], deniedPaths: Record<string, string | null>) {
    // Builtin: fixed safe roots (pseudo-devices, /tmp, os.tmpdir()).
    this.builtinRules = builtinSafeRoots().map((p) => ({
      path: p,
      decision: "allow" as const,
      source: "builtin" as const,
    }));

    // Config: cwd + allowedPaths as allow; deniedPaths as deny (+reason).
    const allow: Rule[] = [
      {
        path: this.normalize(cwd, cwd),
        decision: "allow",
        source: "config",
      },
      ...allowedPaths.map((p) => ({
        path: this.normalize(p, cwd),
        decision: "allow" as const,
        source: "config" as const,
      })),
    ];
    const deny: Rule[] = Object.entries(deniedPaths).map(([p, reason]) => ({
      path: this.normalize(p, cwd),
      decision: "deny" as const,
      reason: (reason ?? "").trim() || undefined,
      source: "config" as const,
    }));
    this.configRules = [...allow, ...deny];
  }

  /** Resolve + POSIX-normalize a path (handles ~, relative-to-cwd, MSYS drives). */
  private normalize(p: string, cwd: string): string {
    return toPosix(resolveTarget(p, cwd));
  }

  /**
   * The single decision entry point. Windows reserved device names (NUL/CON/…)
   * are matched by basename (not prefix) as a fast pre-check; everything else
   * goes through longest-prefix-match across all rule layers.
   */
  decide(target: string): Decision {
    // Windows reserved device names: special builtin (basename match, not prefix).
    if (isWinDeviceName(target)) return { kind: "allow" };

    const posixTarget = toPosix(target);
    const rule = this.mostSpecific(posixTarget);
    if (!rule) return { kind: "outside" };
    return rule.decision === "allow" ? { kind: "allow" } : { kind: "deny", reason: rule.reason };
  }

  /**
   * Longest-prefix match across ALL layers (builtin + config + session). The
   * deepest covering rule wins. A same-depth allow-vs-deny tie resolves to
   * deny — the safe, conservative default for a misconfigured rule set.
   */
  private mostSpecific(target: string): Rule | undefined {
    let best: Rule | undefined;
    let bestDepth = -1;
    for (const r of this.allRules()) {
      if (!underRoot(target, r.path)) continue;
      const depth = segmentDepth(r.path);
      if (depth > bestDepth) {
        bestDepth = depth;
        best = r;
      } else if (depth === bestDepth && best && best.decision !== "deny" && r.decision === "deny") {
        // Same specificity, conflict → deny wins.
        best = r;
      }
    }
    return best;
  }

  private allRules(): Rule[] {
    return [...this.builtinRules, ...this.configRules, ...this.sessionRules];
  }

  // ── session rule management (from the authorization panel) ────────────

  /** Remember an always-allow root. `absPath` is already resolved+absolute. */
  addSessionAllow(absPath: string): void {
    this.remember({
      path: toPosix(absPath),
      decision: "allow",
      source: "session",
    });
  }

  /** Remember an always-deny root with an optional reason. `absPath` is already resolved+absolute. */
  addSessionDeny(absPath: string, reason: string): void {
    this.remember({
      path: toPosix(absPath),
      decision: "deny",
      reason: reason.trim() || undefined,
      source: "session",
    });
  }

  /**
   * Add a session rule with subsumption compaction:
   *   - if a broader SAME-DECISION rule already covers it → no-op (redundant);
   *   - otherwise drop narrower same-decision rules it now subsumes.
   *
   * Cross-decision rules are left untouched — longest-prefix-match handles
   * their interaction naturally, and dropping e.g. a deny beneath a new allow
   * would lose information. This keeps each decision-type set minimal and the
   * status view free of "parent listed next to its own child" oddity.
   */
  private remember(rule: Rule): void {
    const peers = this.sessionRules.filter((r) => r.decision === rule.decision);
    if (peers.some((r) => underRoot(rule.path, r.path))) return; // already covered
    this.sessionRules = this.sessionRules.filter(
      (r) =>
        !(r.decision === rule.decision && r.path !== rule.path && underRoot(r.path, rule.path)),
    );
    this.sessionRules.push(rule);
  }

  /** Forget all session rules (always-allow / always-deny). Config is untouched. */
  clearSession(): void {
    this.sessionRules = [];
  }

  // ── status export ─────────────────────────────────────────────────────

  /** All rules, grouped by source, for `/access-denied status`. */
  getRules(): { builtin: Rule[]; config: Rule[]; session: Rule[] } {
    return {
      builtin: this.builtinRules,
      config: this.configRules,
      session: this.sessionRules,
    };
  }
}
