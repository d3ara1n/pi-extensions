# pi-whisper — 主对话旁路问答（已被取代）

> **状态：已被 [`pi-aside`](./pi-aside.md) 取代** — 2026-06-22。
> 原计划（fork 主 prefix 吃缓存、依赖 sidekick 常驻分栏）经设计讨论推翻，演进为
> pi-aside：**序列化注入模式**（utility 模型 + 自有 system prompt + 阅后即焚），
> 不再依赖 sidekick。完整新设计见 [`pi-aside.md`](./pi-aside.md)。

## 演进要点（为何放弃本计划）

- 旧方案的 fork-prefix 吃缓存有三个死结（工具副作用 / 缓存命中 / system 约束互相矛盾），
  详见 pi-aside.md 的对照表。
- sidekick 常驻分栏已验证搁置（pi 不开放主布局接口），本计划原依赖它无法推进。
- pi-aside 改用 overlay 形态，独立于 sidekick；未来 sidekick 复活时，aside-user 可额外
  注册一个 sidekick tab（共用同一 `investigate()` 核心），即原"whisper 作为 sidekick tab"
  的全局计划以"双入口"形式保留。

本文件保留仅作历史归档，不再维护。
