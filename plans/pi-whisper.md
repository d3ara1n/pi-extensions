# pi-whisper — 主对话旁路问答（搁置）

> **状态：搁置** — 依赖 [`pi-sidekick`](./pi-sidekick.md) 作为常驻容器，随其一起搁置。
> 等 pi 开放主布局/分栏接口、sidekick 复活后即可实施。

## 想法

基于主对话内容、但**不影响主对话**的轻量问答。典型场景：

- 主 agent 正在干大事（跑长任务 / streaming），用户想插话问个小问题又不想打断；
- 想确认某个实现细节，但怕在主对话里问会占用、浪费 token 上下文；
- 纯粹"顺便问一下"——要的是答案，不需要主 agent 介入。

whisper（轻声）取的就是这个意象：主 agent 在大声干活，用户在旁边悄声问个小的，互不打扰。

## 核心机制

1. **读主对话上下文** —— 从 `ctx.sessionManager.getBranch()` 取当前分支的消息序列，
   序列化为文本作为问答的背景材料。
2. **独立推理回答** —— 用 `@earendil-works/pi-ai` 的 `complete()` 发起**一次性**推理
   （不 spawn 整个 pi 子进程，更轻更省）。模型走 [`pi-model-roles`](./model-roles-and-skill-router-v2.md)
   的某个便宜 role（如 `utility` / `fast`）。
3. **与主对话隔离** —— whisper 的问答**不写回主 session**（`complete()` 根本不碰 session），
   这正是"不影响主对话、不占主上下文"的核心。

## 依赖的 API（均已验证可用）

| 能力 | API | 验证来源 |
|------|-----|---------|
| 读主对话分支 | `ctx.sessionManager.getBranch()` → `SessionEntry[]` | pi example `todo.ts` 的 `reconstructState` |
| 一次性 LLM 推理 | `complete()` from `@earendil-works/pi-ai` | pi-subagent 的 `generateSummary` 已用 |
| 解析便宜模型 | `getModelRolesAPI().resolveRoleAsync(role)` | pi-subagent / pi-session-namer 已用 |

无未知 API，无架构风险——**唯一阻塞项是 sidekick 容器**。

## 关键设计点

### 上下文策略（最重要）

主对话可能很长，全量喂 whisper 模型既贵又可能超 context。策略：

- **默认**：最近 N 轮（可配，如最近 6 轮 user+assistant）。
- **超长截断**：超过阈值时保留 head（开头背景）+ tail（最近上下文），drop 中间。
- **可选增强**：优先使用主对话的 compaction summary（若有）作为压缩背景。
- 配置走 sidekick 的 `whisper` 配置块（参考 monorepo 的配置字段约定）。

### 模型选择：utility role 作边栏模型

**硬依赖 [`pi-model-roles`](./model-roles-and-skill-router-v2.md)** —— whisper 不自己配置模型，
而是复用 model-roles 的 `utility` role 作为边栏问答模型（便宜、快、thinking off，
与主对话用的重型 role 区隔，正是「旁路」该有的配置）。用户在 model-roles 配置里调整
`utility` 指向的具体模型，whisper 自动跟随，无需 whisper 侧重复一套模型配置。

### UI（sidekick tab）

- 输入框 + 流式 markdown 回答。
- 复用 pi-subagent 的 `onProgress` 流式渲染思路（whisper 用 `complete()` 时拼接增量）。
- `order` 设 100 左右，排在 todo 之后。

## 为什么强依赖 sidekick

whisper 的核心体验是**"主 agent 干活时，我旁边随时插问、且能看见主对话"**。这要求面板
**常驻可见**且**不遮挡主对话**——正是 sidekick 那种挤压式分栏才能提供的，而模态 overlay
一打开就遮挡主对话、违背初衷。

todo 勉强能用"用完即关的模态"凑合，whisper 不行——这是它对 sidekick 依赖更强的原因。

## 复活条件

sidekick 复活即可。设计上无未解难题，所有依赖 API 已验证。届时实现路径：

1. `getSidekickAPI().registerPanel({ id:"whisper", ... })` 注册 tab；
2. `create()` 返回带输入框的组件，`handleInput` 收用户问题；
3. 提交时取 `getBranch()` 序列化 → 拼系统 prompt → `complete()` → 流式渲染回答。

`SidekickPanel` 协议设计与布局无关，sidekick 归档里已确认仍然有效。
