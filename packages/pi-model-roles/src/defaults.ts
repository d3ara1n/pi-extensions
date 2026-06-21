/**
 * Built-in default role definitions.
 *
 * Only universal roles are built-in. Plugin-specific roles
 * are left for users to define — modelRoles accepts
 * any custom role name.
 *
 * model=null means "use pi's current model, don't switch".
 */

import type { RoleConfig } from "./types.ts";

export const BUILTIN_DEFAULT_ROLES: Record<string, RoleConfig> = {
  default: {
    model: null,
    description: "General development tasks: writing new features, modifying existing code, code review, adding tests, routine debugging, file-level changes",
    thinking: "medium",
  },
  heavy: {
    model: null,
    description: "Tasks requiring deep thinking: cross-file refactoring, architecture design, complex bug debugging, performance optimization, security analysis, database schema changes, multi-module migrations",
    thinking: "high",
  },
  fast: {
    model: null,
    description: "Simple deterministic tasks: one-line edits, formatting tweaks, simple Q&A, doc lookups, git operations, confirmation replies",
    thinking: "low",
  },
  utility: {
    model: null,
    description: "Lightweight utilities: model routing, commit generation, title/summary, etc. (hidden)",
    thinking: "off",
    hidden: true,
  },
};
