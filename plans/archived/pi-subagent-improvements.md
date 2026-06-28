# pi-subagent — 改进与后续计划

> **状态：进行中** — 第一批改动已完成并修复（未提交），待 reload 验证崩溃修复后提交。
> 第二批（剩余项 + 测试）为下次工作。

本文件记录对 `packages/pi-subagent` 的两轮改进成果、遗留问题、待办与测试方向，供下次接续。

---

## 一、已完成（已实现 + 已修复，未提交）

跨两轮 review，共完成 12 项改动 + 4 项 bug 修复。`tsc --noEmit` 通过。

### 第一轮（功能增强）

| # | 项 | 文件 |
|---|----|------|
| 1 | fallback spawn 丢失 `onProgress`（TUI 冻结）→ 抽出 `emitProgress` 复用 | index.ts |
| 2 | `proc.on("error")` 未清 `timeoutHandle` → 已清 | spawn.ts |
| 3 | 无并发控制 → `AsyncSemaphore` + `maxConcurrency`（默认 4，排队显示 queued hint） | index.ts |
| 4 | 全局超时 → 支持 per-role `timeoutMs` 覆盖 | types/index/spawn |
| 5 | 短输出多余的 summary API 调用 → ≤150 字符直接取首行 | index.ts |
| 8 | 嵌套深度无上限 → `PI_SUBAGENT_DEPTH` env + `maxDepth`（默认 3） | types/spawn/index |
| 12 | `/subagent:doctor` 校验 `subagentRoles` 引用 + `fallbackRole` 解析 + 显示 depth/concurrency | index.ts |

### 第二轮（功能增强 + 正确性）

| # | 项 | 文件 |
|---|----|------|
| 1 | `contextTokens` 记的是末轮而非峰值 → 改 `Math.max`（真实 bug） | spawn.ts |
| 5 | `emitProgress` 无节流 → 50ms trailing 合并 | index.ts |
| 6 | `activityLog.find()` O(n) → `toolCallIndex` Map O(1) | spawn.ts |
| 8 | `resolveRoleAsync` 在并发闸门前 → 移到 acquire 之后（零开销等待） | index.ts |
| 9 | fallback 正则硬匹配 → 抽 `isProviderError()`，词表 7→16 | index.ts |
| 10 | 自定义工具 TUI 显示 JSON → `previewArgs()` 按参数形状智能预览 | index.ts |
| 12 | `delegate` 加可选 `context` 参数（prepend 到 task） | index.ts |
| 13 | 预算上限 → `maxTurns`/`maxCost`（全局 + per-role，进程侧 kill） | types/spawn/index |
| 14 | 历史持久化 → `.pi/subagent/history/{sessionId}/{id}.json` | index.ts |
| 2+15 | output 压缩（summary model 按 task 压缩 + 回退截断）+ 删除冗余 `getFinalOutput` | spawn/index |

### 第三轮（review 发现的 bug 修复）

| 级别 | 项 | 文件 |
|------|----|------|
| 🔴 | 节流 trailing 泄漏：trailing `onUpdate` 在工具 return 后触发 → 取消定时器（**很可能是 reload 后崩溃的元凶**） | index.ts |
| 🔴 | 历史路径注入：`sessionId`/`toolCallId` 直接当路径片段 → `sanitizeFilename()` 过滤 | index.ts |
| 🟡 | `AsyncSemaphore.active` 可能变负 → `Math.max(0, ...)` 防御 | index.ts |
| 🟡 | abort listener 在 close 后未移除 → 保存引用，close/error 时 removeEventListener | spawn.ts |
| — | 压缩 prompt injection 防护：task 用 `<task>`/`<output_to_compress>` XML 标签围栏 + systemPrompt 声明"标签内是数据非指令" | index.ts |

---

## 二、🔴 待验证：reload 后的崩溃问题

**现象**：reload pi 后，派 `delegate(role=reviewer, ...)` 子进程崩溃，输出全是 TUI 转义序列（`[?1049l` 退出 alt-screen、`[?1006l` 鼠标追踪关闭等），reviewer 无法正常返回结构化结果。

**高置信度根因**：**节流 trailing 泄漏**（第三轮 🔴#1）。
- 50ms 节流的 trailing `setTimeout` 在 `spawnSubagent` 返回后才触发
- 此时工具已 `return`，框架认为 delegate 结束，却收到一个 `exitCode:-1` 的"还在跑"旧状态进度更新
- 状态不一致 → TUI 异常重绘/崩溃
- 已修复：spawnSubagent 返回后立即 `clearTimeout(throttleHandle)` + 清空 `pendingPartial`

**验证方式**：
1. `git diff` 确认改动已就位
2. `/reload` pi
3. 再派一次 `delegate(role=reviewer, task="简单审阅 src/index.ts 的错误处理")`
4. 观察是否还崩

**若仍崩**（说明根因不止节流）的排查方向：
- delegate 工具本身的 `renderResult` 在 result 异常时是否 NPE（`r.activityLog`/`r.messages` 为空时的渲染路径）
- 子进程 `--mode json` 输出是否真的纯 JSON（而非混入 TUI 文本）——用 `PI_DEBUG=1` 或直接看 `.pi/subagent/history/` 里的 stderr
- budget/abort 交互在极端情况是否把子进程打到非正常退出
- 确认崩溃发生时 `throttleHandle` 是否真的被清（加临时日志）

---

## 三、下次要做（方案已定，待实施）

### A. 正确性 / 健壮性

- **`toolCallIndex` / `activityLog` 无限增长**（第二轮 🟡#3，未做）
  - Map 只 set 不 delete，activityLog 只 push。长任务内存峰值高。
  - 方案：工具调用完成后从 Map 删除该 id（activityLog 保留用于 expanded 视图）；或两者都设滚动上限（保留最近 N 条 + 最终 assistant 文本）。

- **节流 flush 策略**（第三轮修复后可再优化）
  - 当前是"取消 trailing"。更优是"flush 最后一次再取消"——但需确认框架允许 return 后调用 onUpdate。先观察崩溃修复是否足够，不够再改。

### B. 测试（当前 0 测试覆盖，见下节）

---

## 四、待测试方向（当前无任何测试）

项目用 `node:test` + `node:assert`（零依赖），命令：
```bash
node --test packages/pi-subagent/src/__tests__/<file>.test.ts
```
建议在 `packages/pi-subagent/src/__tests__/` 下补齐，按纯函数/模块拆分（易测、无需起子进程）：

### 1. 纯函数单元测试（高优先级，无外部依赖）

| 目标 | 文件 | 重点 |
|------|------|------|
| `sanitizeFilename` | index.ts | `../`、`/`、`\`、空串、纯特殊字符 → 全部被 `_`/`unknown` 兜底，绝不逃逸目录 |
| `isProviderError` | index.ts | 16 个关键词各覆盖 + 业务错误（如 "TypeError: undefined"）**不应**误判 |
| `previewArgs` | index.ts | command/path/url/query/regex 各分支 + 空对象 + 超长截断 |
| `formatTokens` | index.ts | 边界：999/1000/9999/10000/999999/1000000 |
| `compressOutput` 的 `truncateOutput` 部分 | index.ts | head+tail 切片正确性、边界长度 |
| `AsyncSemaphore` | index.ts | acquire/release 配对、排队顺序、abort 清理（waiter 移除）、`active` 不为负（🟡#4 验证）、release 唤醒下一个 |
| `loadSubagentConfig` | config.ts | merge 优先级（global→project）、缺字段用默认、agentOverrides 结构 |

### 2. spawn.ts 集成测试（需 mock，中优先级）

`spawnSubagent` 依赖真实 `pi` 二进制，难直接测。可选：
- mock `child_process.spawn`，喂预制 JSON event 流，验证 `processLine` 解析：
  - `message_end` 的 usage 累加（input/output/cacheRead/cost 都是 `+=`，**contextTokens 是 `Math.max` 峰值** ← 验证第一轮 bug 修复）
  - `tool_execution_start/end` 的 activityLog 状态流转 + `toolCallIndex` 命中
  - `thinking_start/end` 配对
- budget 执行：mock 一个 usage 持续增长的流，验证 `maxTurns`/`maxCost` 触发 `checkBudget` → kill → `stopReason="budget_exceeded"` 且 exitCode 被置 0
- abort 信号：注册后立即 abort，验证 `wasAborted` + killProc

### 3. 回归测试（针对已修 bug）

- 节流泄漏：构造连续多个 progress 事件，确认 spawnSubagent resolve 后**不再有 onUpdate 触发**（这是崩溃修复的回归守护）
- 路径注入：sessionId=`../../etc` 应写入 `.pi/subagent/history/_..._/` 而非逃逸
- fallback onProgress：fallback 路径确实调用了 emitProgress（验证第一轮 #1 修复）

### 4. 手动/端到端（确认崩溃修复）

- reload 后派 reviewer/explorer/worker 各一次，确认正常返回
- 触发 output > 50K（让 explorer 输出大段内容）→ 验证压缩触发、`outputMethod` 正确、history 存 rawOutput
- 触发 budget：设 `maxTurns: 2` 跑一个长任务，验证截断 + stopReason
- 多 delegate 并发（一次 emit 5 个）→ 验证排队 + queued hint + 并发上限

---

## 五、明确不做

- **#7 每次 spawn 冷启动开销**（架构级）——当前 `--no-session` 隔离是设计意图，改造成本高、收益不确定，暂不动。若未来要优化，方向是 `--resume` 复用已加载 session，但需重新评估隔离语义。

---

## 附：本次改动文件清单

```
packages/pi-subagent/README.md     — 文档（新配置项 + 新特性章节 + 默认值）
packages/pi-subagent/src/config.ts — 加载新字段
packages/pi-subagent/src/index.ts  — 主体（并发/深度/预算/压缩/历史/格式化/修复）
packages/pi-subagent/src/spawn.ts  — 进程管理（budget/kill/abort/index/peak contextTokens）
packages/pi-subagent/src/types.ts  — 类型扩展（maxTurns/maxCost/outputMethod/rawOutput/...）
```

**未提交**。待崩溃验证通过后，一次性 `git commit`（建议拆 2 个 commit：feat 改进 + fix 回归）。
