# pi-sidekick — 可停靠侧边面板（搁置）

> **状态：搁置** — 受限于 pi 的 TUI 架构，核心需求"右侧常驻分栏、挤压主区宽度"做不到。
> 原型已开发并验证失败，代码已清理。等 pi 开放主布局/分栏接口后可复活。

## 想法

在 pi 主对话正常跑、正常完成用户请求的同时，提供一个**右侧侧边面板**，里面有多个 tab，
每个 tab 是一个插件提供的面板（panel）。典型用途：

- **btw**：基于主对话内容但不影响主对话的轻量问答——想知道某个细节怎么实现、想确认一下，
  又不想占用主上下文；主 agent 正在干大事时也不方便立即插话。
- **todo**：把现有 todo 视图搬成一个 tab。

核心诉求是**"和主聊天区并排的持久分栏"**，像 IDE 的侧边栏那样——它会**挤压**对话区/编辑区的宽度，
而不是浮在上面。

## 为什么失败

pi 的扩展 UI 能力边界（已查证 `@earendil-works/pi-tui` 与 `@earendil-works/pi-coding-agent` 的
类型定义 + 官方 example 验证）：

| 能力 | 是否提供 | 机制 |
|------|---------|------|
| 浮层 overlay（任意位置/尺寸，含 `right-center`） | ✅ | `ctx.ui.custom({ overlay, overlayOptions })` |
| 浮层不抢焦点（`nonCapturing`） | ✅ | `OverlayOptions.nonCapturing` |
| **改主聊天区/编辑区的布局（挤压宽度）** | ❌ | 主布局容器不开放给扩展 |
| **持久分栏（非浮层，和主区共享屏幕）** | ❌ | 无此接口 |
| 编辑器上下加 widget | ✅ | `ctx.ui.setWidget(..., { placement })` |
| 替换 footer / header | ✅ | `ctx.ui.setFooter / setHeader` |

**根因**：pi 的主界面（聊天历史区 + 编辑器 + footer）是内部硬编码的布局，扩展只能在其上
**叠加浮层**，或往编辑器上下塞 widget、换 footer——但无法把聊天区劈开、把一个组件作为
"占用屏幕右 1/3 且让左 2/3 收缩"的新成员注入主布局。那个主布局容器不暴露给扩展。

> 注：pi **有**焦点系统（`TUI.setFocus`、`OverlayHandle.focus/unfocus`、`Focusable` 接口），
> overlay 之间能做焦点切换。但焦点系统解决不了布局问题——无法让浮层"挤压"主区而非"遮挡"主区。

## 已尝试的原型

开发到 typecheck 通过、尚未上线的版本（已删除）：

- `src/types.ts` — `SidekickPanel` 协议（id/label/icon/order/create）+ `SidekickAPI` 接口
- `src/api.ts` — globalThis 单例注册表（沿用 `pi-model-roles` 的 globalThis 模式）
- `src/home-panel.ts` — 内置 Home tab
- `src/sidebar-component.ts` — 基于 overlay 的容器：tab 栏 + 内容区 + Tab/←→ 切换
- `src/index.ts` — `/sidekick` 命令打开 `ctx.ui.custom({ overlay:true, overlayOptions:{ anchor:"right-center", width:"32%" } })`

实测表现：打开后是一个**浮在右侧的模态 overlay**，盖住右侧聊天内容，且因 capturing 夺走焦点、
编辑区看似"消失"。与"挤压式常驻分栏"的需求不符——证实 overlay 路线行不通。

## 可行的近似方案（当时备选，均未采纳，记录备查）

1. **浮层 overlay + `nonCapturing`**：面板浮右侧不抢焦点，主对话正常显示打字。
   缺点：**遮挡**而非挤压右侧聊天内容。
2. **编辑器下方 widget**（`setWidget placement:"belowEditor"`）：常驻横带，不抢焦点不遮挡。
   缺点：只是一条横带，不是右侧竖栏，空间小。
3. **全屏模态面板**：像 `/todos`、doom-overlay 那样打开即占用、用完关闭。
   缺点：非常驻，但功能完整。

三者都偏离"右侧竖向常驻分栏"的核心诉求，故未采用。

## 复活条件

满足以下任一即可重新评估：

- pi 开放主布局/分栏接口（如允许扩展向主 Container 注入并排组件，或提供 split-pane API）
- pi 提供"可挤压主区的常驻面板"机制（区别于 overlay）

复活时可参照本文件的 `SidekickPanel` 协议设计与 globalThis 注册模式——这部分与布局无关，
仍然有效。
