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
    description: "常规开发任务：编写新功能、修改现有代码、代码审查、添加测试、一般性调试、文件级别的修改",
    thinking: "medium",
  },
  heavy: {
    model: null,
    description: "需要深度思考的任务：跨文件重构、架构设计、复杂 bug 调试、性能优化、安全分析、数据库 schema 变更、涉及多个模块的迁移",
    thinking: "high",
  },
  fast: {
    model: null,
    description: "简单确定性的任务：一行修改、格式调整、简单问答、文档查阅、git 操作、确认类回复",
    thinking: "low",
  },
  utility: {
    model: null,
    description: "轻量辅助：模型路由、commit 生成、标题摘要等（hidden）",
    thinking: "off",
    hidden: true,
  },
};
