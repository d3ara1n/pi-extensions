# pi-subagent — renderCall / renderResult 渲染改版

> 性能优先 > UI 展示效果。旧功能不丢，只整合排版。副作用大于收益的新特性跳过或接下位方案。

## 现状审计

### 当前问题

```
  subagent explorer          ← renderCall（永驻上方）
    find auth middleware...
  ✓ explorer                 ← renderResult 头（role 重复！）
  ─── Task ───
  find the auth middleware... ← task 再次出现
  → grep /auth/ in src       ← activity（无 banner）
  → read src/auth.ts:1-40
  ─── Output ───
  <Markdown 输出>
  2 turns ↑8.9k ↓611 ...
```

**4 个问题：**

| # | 问题 | 原因 |
|---|------|------|
| 1 | role 重复出现 | renderCall 和 renderResult 头各有 "explorer" |
| 2 | task 两次展示 | renderCall 预览（60 字）+ expanded 全文 |
| 3 | `─── Task/Output ───` banner 简陋 | 纯文本 `\u2500\u2500\u2500 X \u2500\u2500\u2500`，无分层感 |
| 4 | files/context 完全没渲染 | delegate 传了 files/context，TUI 看不到 |

### 什么不能丢

- renderCall 的彩色 `subagent` + accent role 头（用户反馈："一眼看出是在 delegate 了一个 explorer"）
- usage 行（turns/tokens/cost/model）
- activity 流（工具调用列表）
- output Markdown 渲染
- error/timeout/budget 状态展示
- queued/running 中间态

### 新需求

- **expanded 显示 files 引用表**（`@path` 每行一个，不显示文件尺寸——避免每帧 I/O）
- **expanded 显示 context 字数**（`ctx 1.2k chars`，一行，直接 `.length`）
- **expanded 显示 task 全文**（从 renderCall 移除 task 行后放到这里）
- **板块间空行分隔**（用 Spacer(1)，框架已有类似机制）
- **折叠时 usage 也显示**
- **成本行加耗时**（需 SubagentResult 加 `elapsedMs` 字段）

## 设计

### 新版式

```
═══ 折叠（默认）═══

  delegate explorer              ← renderCall：永久头（彩色，无 task）
                                 ← 空行（框架 Spacer(1)）
  ✓ 位于 src/auth.ts:42          ← renderResult 头：icon + summary（不重复 role）
                                 ← 空行（运行时不显示 usage）
  12s · 2 turns ↑8.9k $0.0044    ← usage（含耗时，运行中 live elapsed）

═══ 展开（Ctrl+O）═══

  delegate explorer              ← 永久头（彩色）
                                 ← 空行
  ✓ 位于 src/auth.ts:42          ← icon + summary
                                 ← 空行
  @src/auth.ts                   ← 引用表：每个 file 一行
  @src/api.ts
  ctx 1.2k chars                 ← context 字数（只在有 context 时出现）
                                 ← 空行
  find the auth middleware...    ← task 全文（dim）
                                 ← 空行
  → grep /auth/ in src           ← activity（无 banner，已有 prefix glyph）
  → read src/auth.ts:1-40
                                 ← 空行（只在有 output 和 activity 之间）
  <Markdown 输出>                ← output
  (output compressed — ...)      ← 压缩/截断提示（如有）
                                 ← 空行
  12s · 2 turns ↑8.9k $0.0044    ← usage
```

### 有 content 信息但无渲染的空处理规则

| 状态 | 条件 | 渲染 |
|------|------|------|
| task 全文 | 总是有 | 展开时放引用表之后、activity 之前 |
| context | 有则显示 | 展开时 `ctx Nk chars`，一行 dim |
| files | 有则显示 | 展开时每个 `@path`，一行 dim |
| summary | 有则显示 | 折叠/展开都显示（icon 后面），无则退化为 output 第一行截断 |
| output | 有则显示 | 展开时 Markdown 渲染，折叠时仅在无 summary 时退化为一行截断 |
| activity | 有则显示 | 扩展时用已有 formatToolCall/formatThinking |

### 任务结束后不再渲染时的清场规则

运行中：usage 行显示 `⏱ 正在运行中的耗时`（从 `startTime` 实时计算）。
结束后：usage 行显示 `12s · 2 turns ↑8.9k $0.0044`（从 `elapsedMs` 字段，精确）。

## 跳过项及原因

| 手法 | 原因 | 下位方案 |
|------|------|---------|
| `@src/auth.ts  12kb 851w` 文件尺寸 | 每次 render 需 stat + 读文件算字数，I/O 副作用大；pi-tui 无布局原语无法右对齐 | 只显示 `@path` |
| 运行期秒表每秒跳 | 需 setInterval + requestRender 定时重绘，复杂度高，影响主循环性能 | 沿用事件驱动 elapsed |
| 居右对齐 | pi-tui 只有 Container/Text/Markdown/Spacer，无 Row/Flex/Align 原语，需手算宽度 | 不做对齐 |

## 实现步骤

### 1. types.ts — `elapsedMs` 字段

```ts
// SubagentResult 新增
elapsedMs?: number;
```

### 2. spawn.ts — 记录耗时

```ts
// spawnSubagent 开头记录 startTime，close 时：
result.elapsedMs = Date.now() - startTime;
```

### 3. index.ts — renderCall 精简

- 只保留 `subagent <role>` 彩色行
- 删除 task preview 行
- 不显示 files/context（放 renderResult）

### 4. index.ts — renderResult 重写

**折叠：**
- icon + summary（不重复 role）
- usage（附耗时）

**展开：**
- icon + summary
- files 引用表（每行 `@path` dim）
- context 字数（`ctx N chars` dim）
- task 全文（dim）
- activity（保留现有 formatToolCall/formatThinking + status glyph）
- output Markdown
- usage

所有块之间用 Spacer(1) 分隔。运行中时显示 live elapsed。

### 5. 删除 `─── Task/Output ───` banner

两块 section header 直接移除，用空行自然分层替代。

## 验证

1. 折叠状态下 delegate 一个 explorer，确认：彩色头 + ✓ + summary 一行 + usage
2. Ctrl+O 展开，确认：files 表 + task 全文 + activity + output + usage
3. 无 files 无 context 时，不出现空引用表块
4. error/timeout/budget 状态正常显示
5. queued/running 中间态正常
6. typecheck 零错误
