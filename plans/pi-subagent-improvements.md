# pi-subagent 改进计划

> 基于 [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) 的对比分析，生成于 2026-06-06。

## 当前状态

`@d3ara1n/pi-subagent` 是一个精简的子代理扩展（~990 行，5 个核心文件），实现了：

- 4 个内置角色 (explorer/reviewer/worker/researcher)
- 单次子代理执行 + 流式 TUI
- 嵌套权限白名单 (PI_SUBAGENT_ALLOWED)
- pi-model-roles 集成 + 中文摘要
- 输出截断保护 (50KB)
- **并行委托**：主模型一次发出多个 `delegate` 工具调用，pi 框架自动并行执行
- **嵌套委派**：worker 可委派 explorer/researcher，researcher 可委派 explorer
- **Windows 路径解析**：`process.argv[1]` / `import.meta.resolve` / PATH 三级回退

对比参考项目 `pi-subagents`（50+ 文件，~5000+ 行），以下是差距和改进方向。

---

## P0 — 高优先级（实际影响大）

### 1. ~修复 Windows spawn 路径问题~ ✅ 已实施（2026-06-06）

**旧现状**：`getPiInvocation()` 仅返回 `"pi"` 字符串，pi 不在 PATH 时失败。

**已实施**：`spawn.ts` 的 `getPiInvocation()` 现采用三步策略：
- **Windows**：
  1. `process.argv[1]` 如果是可执行脚本 → `spawn(process.execPath, [argv1, ...args])`（`bun` 模式）
  2. `import.meta.resolve("@earendil-works/pi-coding-agent")` → 读 `bin` 字段 → `spawn(process.execPath, [binPath, ...args])`
  3. 兜底 `spawn("pi", args)`（从 PATH 走）
- **非 Windows**：直接 `spawn("pi", args)`（不变）

**注意**：参考项目用 `process.execPath` 启动的是 bun（不是编译版 exe 的虚拟路径），同时先用 `process.argv[1]` 或 `import.meta.resolve` 解析出**真实的 CLI 脚本路径**。虚拟路径出现时前两步会失败并降级到兜底，永远不会被实际传给子进程。详见 `resolveWindowsPiCliScript()`。

**行动项**：
- [x] 修改 `getPiInvocation()` 增加 Windows 回退逻辑
- [ ] 在 Windows 上测试 `pi` 不在 PATH 时的行为

---

### 2. 添加 Parallel 并行执行支持

**现状**：主模型可通过同时发出多个 `delegate` 工具调用，利用 pi 框架原生的多工具调用并行机制实现并行。`promptGuidelines` 中专门教导模型：
> "For multiple independent subagent tasks, emit multiple `delegate` tool calls in the same turn — they run in parallel automatically."

**但在以下方面还有差距**（`pi-subagents` 的 parallel API）：
- 无专用 `agents: [{name, task}, ...]` 数组参数的 parallel API
- 无多 TUI slot 实时汇总各子代理进度
- 无 git worktree 隔离（并行写入文件的安全保障）

**行动项**：
- [ ] 设计 parallel 执行的专用参数 schema（可选，当前机制已可用）
- [ ] 多 TUI slot 展示多个并行子代理
- [ ] 评估是否需要 worktree 隔离

---

### 3. 添加模型回退 (fallbackModels)

**现状**：单一模型依赖，provider 限流/宕机时子代理直接失败。

**参考做法**（`pi-subagents`）：
- 每个角色可配置 `fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]`
- 主模型失败时（quota/auth/timeout 类错误），按序尝试回退模型
- 只在 provider 级别错误时回退，普通任务失败不回退

**行动项**：
- [ ] 在 `SubagentRole` 类型中添加 `fallbackModels` 字段
- [ ] 修改 `spawnSubagent` 增加 retry 循环
- [ ] 区分 provider 错误 vs 任务错误

---

## P1 — 中优先级（显著提升体验）

### 4. Agent 覆盖系统

**现状**：内置角色在 `roles.ts` 中硬编码，用户想改模型或工具必须改源码。

**参考做法**（`pi-subagents`）：
- `settings.json` 中 `subagents.agentOverrides.<name>` 可覆盖 model/thinking/tools/skills/systemPrompt/disabled
- 不需要复制整个 agent 定义文件
- 支持批量禁用内置角色 (`disableBuiltins: true`)

**行动项**：
- [ ] 设计 override schema
- [ ] 修改配置加载逻辑，合并 override 到内置角色
- [ ] 允许用户在 settings 中添加自定义角色

---

### 5. ❌ Chain 链式执行 — 设计决策：不实现

**理由**：pi-subagent 的设计原则是「主模型做决策，子代理执行具体任务」。链式编排意味着子代理之间传递上下文、多步流水线——这本质上是编排工作，应该由主模型来主导。主模型会在每步之后检查结果、决定下一步派谁。

**替代方式**：主模型需要多步时，直接连续调用 `delegate` 即可，每步都可检查结果再决定下一步：
```
主模型: delegate(explorer) → 返回结果 → 主模型检查 → delegate(worker) → ...
```

---

### 6. ❌ Fork 上下文模式 — 设计决策：不实现

**理由**：fork 是为了让子代理「理解前因后果」后做判断——这更适合 planner/oracle 这类参谋角色。但 pi-subagent 的定位是**执行者**而非**参谋者**：
- 主模型拥有最完整的上下文，决策应由主模型做出
- 子代理只需要清晰的任务描述，不需要知道讨论历史
- 如果某个子代理确实需要上下文，主模型可以在 task 描述中携带必要的背景信息

> 详见 `spawn.ts` 中 `getPiInvocation()` 设计权衡的分析：参考项目 nicobailon/pi-subagents 确实实现了 fork 模式，但那是为 planner/oracle 等决策角色服务的。我们的 4 个角色（explorer/reviewer/worker/researcher）全是执行型，fresh 上下文是正确选择。

---

### 7. Background/Async 后台执行

**现状**：子代理运行时阻塞主会话。

**参考做法**（`pi-subagents`）：
- `--bg` 标志或 `action: "run-async"` 触发后台执行
- 异步作业追踪器 (`async-job-tracker.ts`) + 结果文件系统
- `result-watcher.ts` 轮询结果目录
- 完成时发送通知
- `subagent({ action: "status" })` 查看运行状态

**行动项**：
- [ ] 设计 async 执行架构
- [ ] 实现后台子进程 spawn + 状态持久化
- [ ] 实现结果文件 + 轮询/通知机制
- [ ] TUI 添加 async widget

---

## P2 — 低优先级（锦上添花）

### 8. Slash 命令

**参考**：`/run [agent] "task"`, `/chain step1 -> step2`, `/parallel task1 -> task2`, `/subagents-doctor`

**行动项**：
- [ ] 使用 `pi.registerCommand()` 注册命令
- [ ] 解析命令参数 + 路由到对应执行模式

---

### 9. Intercom 双向通信

**参考**：子进程可通过 `contact_supervisor` 工具主动与父进程通信，父进程可下发控制指令。

**行动项**：
- [ ] 调研是否需要 `pi-intercom` 配合
- [ ] 设计文件系统事件通道

---

### 10. Acceptance Gate

**参考**：子代理完成后自动评估输出质量，分为 attested/checked/verified/reviewed 4 级。

**行动项**：
- [ ] 设计验收规则和级别
- [ ] 实现自动验收逻辑

---

### 11. 更多内置角色

**参考项目有 8 个**，当前只有 4 个。参考项目额外有：`planner`、`oracle`、`context-builder`、`delegate`。

**设计决策**：`planner` 和 `oracle` 是参谋型角色（需要理解全局上下文），不匹配 pi-subagent「执行者」的定位，**不引入**。

可以考虑引入的：

| 新角色 | 用途 | 是否执行型 |
|--------|------|-----------|
| `context-builder` | 强化的上下文收集，输出 context.md | ✅ 执行型（收集信息输出文件） |
| `delegate` | 轻量通用代理，行为接近父会话 | ⚠️ 与现有 4 角色分工重叠 |

---

### 12. 角色定义外部化

**现状**：角色在 `roles.ts` 中 TypeScript 硬编码。

**参考做法**：
- 每个角色一个 `.md` 文件（YAML frontmatter + markdown body）
- 三层发现：builtin → user (`~/.pi/agents/`) → project (`.pi/agents/`)
- 运行时 CRUD：通过工具动态创建/更新/删除角色

**行动项**：
- [ ] 设计 `.md` frontmatter 格式
- [ ] 实现角色发现和加载逻辑
- [ ] 迁移内置角色到 .md 文件

---

### 13. 单元测试

**参考项目有 50+ 单元测试 + 20+ 集成测试**。当前无任何测试。

**行动项**：
- [ ] 为 `spawnSubagent` 核心逻辑添加测试（mock child_process）
- [ ] 为配置加载添加测试
- [ ] 为角色解析添加测试
- [ ] 为 TUI 渲染函数添加测试

---

### 14. Diagnostics 诊断工具

**参考**：`/subagents-doctor` 检查配置正确性、依赖是否安装、路径是否可用。

**行动项**：
- [ ] 添加 `pi.registerCommand("subagent:doctor", ...)` 命令
- [ ] 检查项：pi 可执行、pi-model-roles 已加载、配置格式正确

---

### 15. 摘要调用 token 保护

**现状**：子代理完整输出全部发给摘要模型，大输出时可能消耗大量 token。

**行动项**：
- [ ] 截断发送给摘要模型的 input（如只发最后 4KB）
- [ ] 或配置化摘要输入大小限制

---

## 参考项目关键文件索引

| 功能模块 | 参考文件路径 |
|---------|-------------|
| 扩展入口 | `src/extension/index.ts` |
| 工具 Schema | `src/extension/schemas.ts` |
| 配置 | `src/extension/config.ts` |
| Agent 系统 | `src/agents/agents.ts`, `agent-selection.ts`, `agent-management.ts` |
| 前台执行 | `src/runs/foreground/subagent-executor.ts`, `execution.ts` |
| 后台执行 | `src/runs/background/subagent-runner.ts`, `async-execution.ts` |
| Pi 启动 | `src/runs/shared/pi-spawn.ts` |
| 工作流图 | `src/runs/shared/workflow-graph.ts` |
| 嵌套事件 | `src/runs/shared/nested-events.ts` |
| Intercom | `src/intercom/intercom-bridge.ts`, `result-intercom.ts` |
| 类型定义 | `src/shared/types.ts` |
| Slash 命令 | `src/slash/slash-commands.ts` |
| TUI | `src/tui/render.ts`, `render-helpers.ts` |
| 内置角色 | `agents/*.md` (scout, researcher, planner, worker, reviewer, context-builder, oracle, delegate) |
| 技能 | `skills/pi-subagents/SKILL.md` |
| 提示模板 | `prompts/*.md` |
| 测试 | `test/unit/*.test.ts`, `test/integration/*.test.ts` |

本地克隆路径：`\tmp\pi-github-repos\nicobailon\pi-subagents`
