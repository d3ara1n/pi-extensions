/**
 * Built-in default role definitions.
 *
 * Only universal roles are built-in. Scout/subagent-specific roles
 * (like "side") are left for users to define — modelRoles accepts
 * any custom role name.
 *
 * model=null means "use pi's current model, don't switch".
 */

import type { RoleConfig } from "./types.ts";

export const BUILTIN_DEFAULT_ROLES: Record<string, RoleConfig> = {
  default: {
    model: null,
    description: "日常编码，速度和质量平衡",
    thinking: "medium",
  },
  heavy: {
    model: null,
    description: "架构设计、深度调试、复杂迁移",
    thinking: "high",
  },
  fast: {
    model: null,
    description: "快速修改、简单问答",
    thinking: "off",
  },
};
