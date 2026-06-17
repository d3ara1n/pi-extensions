# pi-todo — 任务管理面板（搁置）

> **状态：搁置** — 依赖 [`pi-sidekick`](./pi-sidekick.md) 作为常驻容器，随其一起搁置。
> 等 pi 开放主布局/分栏接口、sidekick 复活后即可实施。

## 想法

pi 的任务管理工具。LLM 通过 `todo` 工具增删改查任务；用户通过 sidekick 的 **Todo** tab
随时查看当前任务列表。本质是把 pi 自带的 todo 能力从"用完即关的模态"升级为"常驻可见的侧栏面板"。

**为什么要放进 sidekick 侧栏**：现装的 `@juicesharp/rpiv-todo` 是全屏渲染——任务一多，
就把主对话的文本输出区挤到只剩约 4 行，几乎没法看输出。这类「常驻、需要随时可见、
又不想占用主区域垂直空间」的内容，正是侧边竖栏的合适归宿：侧栏占宽度不占高度，
todo 列表再长也不挤压对话输出区。

没什么复杂设计，就是一个 todo 工具——它的价值在**形态**，不在工具能力本身。

## 依赖与前置

- **硬依赖**：[`pi-sidekick`](./pi-sidekick.md) —— 本插件是 sidekick 的一个 tab，
  通过 `getSidekickAPI().registerPanel(...)` 注册。没有 sidekick 容器就没有常驻面板。
- **前置条件**：pi 开放主布局接口（见 sidekick 归档的"复活条件"）。

## 设计要点

- `todo` 工具：`list` / `add(text)` / `toggle(id)` / `clear`，参数 schema 用 TypeBox。
- 状态持久化：走 `pi.appendEntry()` 写 session entry，支持分支（参考 pi 官方 todo.ts example
  的 `reconstructState` —— 从 `ctx.sessionManager.getBranch()` 重建状态）。
- sidekick tab：只读展示当前任务列表（勾选状态 + 文本），`order` 设 50 左右排在 Home 之后。
- 不需要自己的命令——入口就是 sidekick 的 tab。

## 参考

- pi 官方 example：`examples/extensions/todo.ts`（完整实现，含工具 + `/todos` 命令 + 状态重建，
  可直接借鉴工具逻辑，把 `/todos` 命令换成 sidekick panel 注册）。
- 现装第三方包 `@juicesharp/rpiv-todo`（settings.json packages 里）——本插件的动机来源：
  它的全屏渲染在 todo 多时挤压输出区，侧栏形态正好解决这个问题。

## 复活条件

sidekick 复活即可。届时照搬 pi example 的工具逻辑，套上 `SidekickPanel` 协议注册即可。
