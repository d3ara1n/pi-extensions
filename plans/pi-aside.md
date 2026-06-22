# pi-aside — 主对话旁路调查（阅后即焚）

> **状态：待实施** — 由 [`pi-whisper`](./pi-whisper.md) 演进而来。原 fork-prefix 吃缓存方案
> 经设计讨论被推翻，改为**序列化注入模式**：把主对话序列化为纯文本，喂给 utility 模型，
> 用 aside 自有的 system prompt 作答。更简单、更隔离、更便宜，彻底绕开了 fork 方案的所有难题。

## 想法

主 agent 与用户正常工作时，提供一个**不影响主对话**的旁路调查通道。两类使用者：

- **用户**：主 agent 在跑长任务 / streaming，想插话问个原理、确认个细节，又不想占用主上下文。
- **外部监管 agent**（架构留口，暂不实现）：系统内的另一个进程想"调查"用户和助手在干什么，
  但绝不能打断或影响他们的工作。

aside（戏剧"旁白"）取的就是这个意象：剧情（主对话）照常推进，旁白（aside）在一侧解说，
讲完即逝，不留痕迹。

## 核心机制：序列化注入（非 fork）

**关键决策**——不 fork 主 agent 的 prefix，而是把主对话**序列化为纯文本参考材料**，
配合 aside 自有的 system prompt，一次性 `complete()` 给 utility 模型：

```
investigate(question):
  1. 序列化主对话分支 → referenceText（纯文本，含工具调用摘要）
  2. complete(utilityModel, {
       systemPrompt: ASIDE_CONSULT_PROMPT,     // aside 自有，不复用主 agent 的
       messages: [{ role: user, content: referenceText + "\n\n" + question }]
     })
  3. 返回答案，丢弃一切（阅后即焚）
```

### 为什么放弃 fork-prefix 方案

旧方案（fork 主 agent 的 system+tools+messages，靠 prefix 一致吃 prompt cache）有三个死结：

| 难题 | 旧方案下的困境 | 序列化注入如何解开 |
|------|--------------|-------------------|
| 工具副作用 | fork 出的 agent 继承工具，会改文件；零工具又破坏 prefix | 序列化成文本就不是 tool_use block，模型物理上无法调用 |
| 缓存命中 | 零工具→tools 段 prefix 断裂→messages 段失效；加约束文字→system 段失效 | utility 模型本就便宜（约主模型 1/5），不在乎缓存 |
| system prompt 约束 | 加约束→破 prefix；不加→agent 以为自己是主 agent | aside 用全新 system prompt，随便写，无此矛盾 |

序列化注入同时解决了三者，代价只是"序列化丢一点结构信息"——对"解释原理/调查状态"类需求完全够用。

### 阅后即焚的保证

- `complete()` 是 pi-ai 的纯函数，**不碰主 session**，不创建任何 session 文件
- 序列化文本每次实时构建、用完丢弃；aside 不维护持久线程状态
- 不使用 `pi.appendEntry()`（区别于 btw 的 hidden entry 持久化）
- 退出 aside 即一切消失，reload/重启后无 aside 历史残留

## 多包架构

沿用 monorepo 已验证的 [`pi-model-roles`](./model-roles-and-skill-router-v2.md) 模式
（globalThis 状态 + `getAsideAPI()` + `session_start` 初始化 + 消费者 import 类型）。

```
packages/pi-aside/         核心库，提供能力（不注册工具/命令）
  ├─ 序列化主对话 → referenceText
  ├─ investigate(ctx, question) API（入口无关纯函数）
  └─ tracker：主 agent 状态快照（在干嘛/第几轮/当前工具）

packages/pi-aside-user/    TUI 入口（现在做）
  └─ /aside 命令 + overlay 悬浮框，调用 getAsideAPI().investigate()

packages/pi-aside-agent/   外部监管入口（架构留口，暂不建）
  └─ 未来：unix domain socket listener，调用同一个 investigate()
```

**入口无关设计**：`investigate()` 是纯函数，签名不依赖任何 UI/IPC 形态。未来加 aside-agent
只是新增一个 listener 调它，核心三文件（序列化 + investigate + tracker）零改动。这就是"架构留口"。

### 主插件"提供能力"的边界（澄清）

aside 主插件**不管理持久 subsession**（那是 btw 的模式，违背阅后即焚）。它提供的"能力"是：

1. `serializeMainConversation(ctx)` — 序列化主对话为文本
2. `investigate(ctx, question, opts)` — 一次性调查（阅后即焚）
3. `getMainAgentStatus()` — 读 tracker 快照（主 agent 当前状态）

状态仅 tracker 的实时快照（存 globalThis），无 subsession、无线程历史。

## 序列化策略（关键设计点）

来源：`ctx.sessionManager.getBranch()` → 当前分支的 `SessionEntry[]`。

### 格式

```
## 用户
<user message text>

## 助手
<assistant text content>
（thinking 默认不取，可配置）

### 工具调用: bash
$ <command>
→ <result, 截断到 500 字符 head200+tail200>

### 工具调用: read
<path>
→ <result, 截断>

## 用户
<next user message>
...
```

工具调用作为 assistant 消息的子区块（缩进/子标题），保留"谁在何时调了什么得到什么"的因果链，
但参数和结果做长度截断，避免单条 tool result 撑爆 context。

### 截断策略（按优先级）

1. **单条 tool result** > 500 字符 → head 200 + tail 200 + `[truncated]`
2. **整体序列化** > 50k 字符（约 utility 模型 context 的 1/3，留余量给问答）：
   - 默认取**最近 N 轮**（N 可配，默认 10 轮 user+assistant）
   - 可选 head+tail 模式（保留开头背景 + 最近上下文，drop 中间）
3. **超长 assistant thinking** → 默认丢弃（调查不需要推理过程，只要结论）

配置走 settings.json 的 `aside` 块（参考 monorepo 配置字段约定）。

## 模型选择：utility role

**硬依赖 [`pi-model-roles`](./model-roles-and-skill-router-v2.md)** —— aside 不自己配模型，
复用 `utility` role（便宜、快、thinking off）。

```typescript
const rolesApi = getModelRolesAPI();
const resolved = await rolesApi.resolveRoleAsync("utility");
const response = await complete(resolved.model, context, {
  apiKey: resolved.apiKey,
  headers: resolved.headers,
});
```

用户在 model-roles 配置里调整 `utility` 指向的具体模型，aside 自动跟随。

### 为什么不在乎缓存

utility 模型（haiku/mini 级）单价约主对话模型（sonnet 级）的 1/5。即便序列化文本全价计入，
实际等效成本可能比"主模型吃 system 缓存"还低。粗算（30KB system 等效序列化）：

| 方案 | 成本 |
|------|------|
| 主模型 sonnet + 吃缓存 | 30KB × 0.1 = 3.0 KB-sonnet 价 |
| utility haiku + 全价 | 30KB × 0.2（1/5 单价）≈ 0.6 KB-sonnet 等效价 |

且每次调查都是独立的 cache key，不影响主 agent 自己的缓存条目——主 agent 该命中照常命中。

## aside 自有 system prompt

不复用主 agent 的 system prompt（那套"你是编码助手、可以编辑文件"的指令对 aside 无意义且有害）。
aside 用专用的咨询助手 prompt：

```
你是 aside，一个编程咨询助手。下面是一场编码助手与用户的对话记录（已序列化为文本）。
请基于这段记录回答用户的问题。

规则：
- 你只负责解释、澄清、咨询，不执行任何操作（你也无法执行）
- 严格基于记录作答；记录中未提及的，明确说"记录中未提及"，不要编造
- 回答简洁精准，聚焦问题本身
```

## 多轮 QA（aside-user overlay 内）

aside-user 在 overlay 内自己维护一个 messages 数组（不碰主 session）：

```
[0] { role: user,      content: referenceText + "\n\n问题1" }   ← 首轮注入序列化参考
[1] { role: assistant, content: answer1 }
[2] { role: user,      content: "问题2" }                        ← 后续轮只追加新问题
[3] { role: assistant, content: answer2 }
...
```

每轮 `complete()` 用这个累积数组。首轮注入参考文本后，后续轮次无需重复序列化（省钱）。
退出 overlay 即丢弃整个数组。

## UI 形态

### 现在：overlay 悬浮框（aside-user）

参考 dbachelder/pi-btw 的 overlay 模式（`ctx.ui.custom({ overlay:true, overlayOptions })`）：

```
┌─ aside 调查 (ESC关闭) ────────────────────┐
│ 状态: 主agent执行 bash `npm test`(第3工具) │ ← tracker 提供
│ 模型: utility → haiku                      │
│───────────────────────────────────────────│
│ You: 那个 debounce 实现原理?               │
│ 用了 requestAnimationFrame...              │
│                                            │
│ > _                                        │
└───────────────────────────────────────────┘
（底下主会话仍可见）
```

- `Alt+/` 在 aside overlay 和主编辑器间切焦点（pi 焦点系统支持，见 sidekick 文档）
- ESC 关闭，关闭即焚

### 未来：sidekick tab（全局计划，暂不做）

[`pi-sidekick`](./pi-sidekick.md) 若复活（等 pi 开放布局接口），aside-user **额外**注册一个
sidekick tab，共用同一个 `investigate()` 核心。即"双入口"：

- overlay 入口：现在做，临时旁白体验
- sidekick tab 入口：未来做，常驻并排体验

`SidekickPanel` 协议与布局无关，sidekick 文档确认仍有效——复活时 aside-user 注册 tab 零障碍。
**aside-user 现在不依赖 sidekick**（sidekick 已验证搁置）。

## 和 btw 的差异（差异化定位）

| 维度 | btw（业界） | pi-aside |
|------|------------|----------|
| 子会话 | 真实持久 sub-session | 无 session，complete() 纯函数 |
| 工具 | 完整 read/bash/edit/write | 零工具（序列化文本无法调用） |
| 持久化 | hidden entry 可恢复 | 阅后即焚，零残留 |
| 上下文 | fork 主 prefix 吃缓存 | 序列化注入，utility 模型 |
| 定位 | 并行子 agent | 纯咨询旁白 |

aside 是 btw 生态里缺的"绝对零副作用旁白"——不能干活，只答疑，问完即焚。

## 依赖的 API（均已验证可用）

| 能力 | API | 验证来源 |
|------|-----|---------|
| 读主对话分支 | `ctx.sessionManager.getBranch()` → `SessionEntry[]` | pi example、pi-whisper 计划已验证 |
| 一次性 LLM 推理 | `complete()` from `@earendil-works/pi-ai` | pi-subagent 的 `generateSummary` 已用 |
| 解析 utility 模型 | `getModelRolesAPI().resolveRoleAsync("utility")` | pi-subagent / pi-session-namer 已用 |
| 主 agent 状态追踪 | `agent_start` / `tool_execution_*` / `turn_end` hook | extensions.md 已验证 |
| overlay UI | `ctx.ui.custom({ overlay:true, overlayOptions })` | dbachelder/pi-btw、sidekick 文档已验证 |
| 多包状态共享 | globalThis + `getAsideAPI()` 模式 | pi-model-roles 已验证 |

无未知 API，无架构风险。

## 实现路径

### 包结构

```
packages/pi-aside/src/
  ├─ serialize.ts    ~80行  序列化主对话 → referenceText（格式+截断）
  ├─ investigate.ts  ~60行  入口无关核心: 序列化 + complete() + 自有system prompt
  ├─ tracker.ts      ~50行  主agent状态快照（hook 驱动，存 globalThis）
  ├─ api.ts          ~40行  getAsideAPI() / initAsideAPI()（globalThis 单例）
  ├─ types.ts        ~30行  InvestigateOptions/Result、AsideAPI、MainAgentStatus
  └─ index.ts        ~30行  session_start 初始化 + 注册 tracker hook（不注册命令）

packages/pi-aside-user/src/
  ├─ overlay.ts      ~200行 overlay 组件（参考 dbachelder btw 的 BtwOverlay）
  ├─ session.ts      ~50行  aside-user 自己的 messages 累积 + 流式渲染
  ├─ types.ts        ~20行
  └─ index.ts        ~40行  /aside 命令 + 快捷键 + Alt+/ 焦点切换
```

### 实现顺序

1. `pi-aside` 核心三件套：serialize → investigate → tracker，`tsc --noEmit` 验类型
2. `pi-aside` api + index（globalThis 装配 + hook 注册）
3. `pi-aside-user` overlay UI（参考 btw 的 BtwOverlay，但去掉工具调用渲染——aside 无工具）
4. `pi-aside-user` 命令注册 + 焦点切换
5. 用户 `/reload` 后实测（按 AGENTS.md，扩展改动需手动重载）

### settings.json 加载

```jsonc
{
  "extensions": [
    "/Users/chien/Projects/pi-extensions/packages/pi-aside",
    "/Users/chien/Projects/pi-extensions/packages/pi-aside-user"
  ],
  "aside": {
    "recentTurns": 10,           // 截断时的最近轮数
    "maxChars": 50000,           // 整体序列化字符上限
    "toolResultLimit": 500       // 单条 tool result 截断阈值
  }
}
```

## 未决/可演进项

- **aside-agent（IPC 入口）**：架构已留口，等 TUI 版验证体验后再做。首选 unix domain socket
  （系统内、不暴露主机外、免鉴权、不占端口），`investigate()` 签名已支持 `onToken` 流式回调。
- **sidekick tab 入口**：等 sidekick 复活。
- **模型选择可配置**：当前固定 utility role。未来可加配置项允许切到主对话模型（用于超复杂推理问题）。
