# pi-subagent — renderCall / renderResult 渲染设计

> delegate 工具的 TUI 渲染分层设计。性能优先 > UI 展示效果。

## 渲染分层

渲染分三段：**固定 header + 中间详情（仅展开）+ usage**。折叠/展开共享 header 结构，中间详情块只在展开时出现。

### 固定 header

```
  delegate <role>              ← title（renderCall，toolTitle 粗体 + accent）
  <taskline>                   ← task 预览（始终单行）
  [<resultline>]               ← 仅完成时
```

**taskline**——task 首行，截断 70 字，始终单行锚点。状态指示器前缀：

| 状态 | taskline |
|------|---------|
| running | `⏳ (running) <预览>` |
| queued | `⏸ (queued) <预览>` |
| 完成 | 纯文本 `<预览>`（无指示器） |

**resultline**——完成时出现的固定行，形式 `<icon> <content>`，折叠/展开位置一致：

| 状态 | icon | content | 色（icon 与 content 同色） |
|------|------|---------|------|
| success | `✓` | AI summary | success + text |
| error | `✗` | errorMessage | error |
| timeout | `⏱` | errorMessage 或 "Timed out" | warning |
| budget | `⏲` | errorMessage 或 "Budget exceeded" | warning |

> 展开完成时 header 同样有 resultline（图标 + summary/error 文本）。展开的 full output 在下方，但 resultline 仍作为固定锚点保留。

### 中间详情（仅展开）

```
  @<file>                      ← input 块（files + context + task 全文，三者合并无内空行）
  ctx N chars
  <task 全文>                  ← dim
  <Spacer(1)>
  <activity 流>                ← 展开总显示；折叠仅 running 显最近 5 条
  <Spacer(1)>
  <Markdown output>            ← 仅展开且完成时
  (output compressed/truncated — ...)   ← 压缩/截断提示（如有）
```

**input 块合并**：files 引用（每行 `@path`）、context 字数（`ctx N chars`）、task 全文，三者都是 subagent 的输入，聚成一组，块内不插空行分隔。

**activity**：用 `formatToolCall` / `formatThinking` + status glyph（`→` running / `•` done / `✗` failed）。展开时进行/完成都显示；折叠时仅 running 显最近 5 条。

### usage 行（始终）

```
  12s · 2 turns ↑8.9k ↓611 $0.0044 deepseek-v4-pro
```

耗时前缀 + 现有 stats，用 `·` 分隔：

| 状态 | 耗时来源 |
|------|---------|
| running | `startTime` 实时算（`Date.now() - startTime`） |
| 完成 | `elapsedMs` 冻结值 |
| queued | 不显示耗时（排队不计入运行） |

事件驱动刷新（throttle），不做每秒 setInterval。

## 状态机

```
queued   exitCode=-1, queued=true        ⏸ taskline，无 startTime
  ↓ (acquire slot)
running  exitCode=-1, queued=undefined    ⏳ taskline + 实时 activity
  ↓ (spawn 完成)
finished exitCode=0/!=0                   resultline + (展开: output)
```

## 数据字段（SubagentResult）

execute 层负责填入 TUI 可见帧上的辅助字段（非子进程产出）：

| 字段 | 谁填 | 用途 |
|------|------|------|
| `startTime?: number` | execute | 运行中帧的实时耗时计算 |
| `elapsedMs?: number` | execute（spawn 后） | 终态冻结耗时，覆盖整个 delegate 区间（含 fallback 重试） |
| `files?: string[]` | execute（从 params.files） | 展开渲染 `@path` 引用表 |
| `context?: string` | execute（从 params.context） | 展开渲染 `ctx N chars` |

**计时全归 execute**：`startTime`（闭包，acquire 后赋值）和 `elapsedMs`（spawn 返回后盖）都在 execute 层处理，`spawn.ts` 不参与计时。`utils.ts#elapsedSeconds()` 纯函数根据 `exitCode`/`startTime`/`elapsedMs` 返回秒数。

## 空状态规则

每个块为空（无 files / 无 context / 无 output / 无 activity）则整块连同前导 Spacer(1) 一起跳过，避免双空行。

| 内容 | 折叠 | 展开 |
|------|------|------|
| task 预览 | taskline 始终 | 同 |
| summary | resultline（成功时）；无则空 | 同 |
| files | — | 每行 `@path`（有才显示） |
| context | — | `ctx N chars`（有才显示） |
| task 全文 | — | dim |
| activity | 仅 running 显最近 5 条 | 总显示 |
| output | — | Markdown（仅完成时） |

## 设计取舍

| 不做 | 原因 |
|------|------|
| `@path  12kb 851w` 文件尺寸 | 每次 render 需 stat + 读文件，I/O 副作用大 |
| 运行期秒表每秒跳 | 需 setInterval + requestRender，影响主循环 |
| 居右对齐 | pi-tui 无 Row/Flex/Align 原语，需手算宽度 |
| `─── Task/Output ───` banner | 用 Spacer 自然分层替代，更轻 |

## timeout 配置（秒）

用户配置单位为秒，默认 `timeout: 600`（10 分钟）。`effectiveTimeout(role, baseTimeout)` 秒进秒出，唯一转 ms 处是调用 `spawnSubagent` 时 `* 1000`（`setTimeout` API 要求，不泄露到配置层）。`spawn.ts` 内部仍用 ms（内部 API，正确）。

delegate-capable 角色无显式 timeout 时自动 2×；显式 per-role `timeout` 始终原样采用。
