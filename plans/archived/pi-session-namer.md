# pi-session-namer — 自动会话命名插件

> **状态：已实施** ✅ — 代码位于 `packages/pi-session-namer/`
>
> 所有依赖 API 已验证可用：
> - `pi.setSessionName(name)` / `pi.getSessionName()` 设置和获取会话名（同步）
> - `@earendil-works/pi-ai` 的 `complete()` 可在 extension 内调 LLM
> - `@d3ara1n/pi-model-roles` 的 `getModelRolesAPI()` / `resolveRoleAsync()` 可解析 cheap 模型

---

## 1. 背景与动机

pi 的 `/resume` 会话选择器默认显示每条会话的**第一条消息截断文本**作为标识。当会话数量多了以后，很难从一堆 `"帮我改一下..."`、`"这个问题怎么解决..."` 中快速找到目标会话。

pi 提供了 `/name` 命令和 `pi.setSessionName()` API 支持手动命名，但用户几乎不会主动去用。自动命名可以在用户无感知的情况下，让每条会话都有一个有意义的标题。

### 为什么不是 pi-scout 的一个模块

| 维度 | pi-scout | session naming |
|------|----------|----------------|
| 生命周期 | 每轮 `before_agent_start` | 一次（首轮） |
| 输出 | 修改 system prompt + 切换模型 | 设置会话显示名 |
| 首轮额外开销 | 已有 1 个 side agent 调用 | 再加 1 个 = 双倍延迟 |
| 职责 | per-turn 路由 | session 元数据 |

合并到 scout 会 dilute 其 "per-turn routing" 的清晰定位，且需要在 `before_agent_start` 中加 guard 逻辑判断是否首轮、是否已命名。独立插件更干净。

---

## 2. 功能设计

### 2.1 核心行为

```
用户发送第一条 prompt
    │
    ▼
before_agent_start 触发
    │
    ├─ 检查 pi.getSessionName() === undefined（未命名）
    ├─ 检查 session entry 数量（确认是首轮）
    │
    ├─ 调用 cheap side agent，输入用户 prompt
    ├─ 返回简短会话名（≤50 字符）
    └─ pi.setSessionName(name)
```

**触发条件**（全部满足）：
1. `config.enabled === true`
2. `pi.getSessionName()` 返回 `undefined`（当前会话未被命名）
3. 是本轮会话的第一条用户消息（通过 `ctx.sessionManager.getBranch()` 长度判断，或维护 `hasNamed` flag）

**不触发的场景**：
- `/resume` 恢复的会话（已有 name 或已有足够 entry）
- `/fork` / `/clone` 的会话（已有上下文）
- 用户已通过 `/name` 或 `--name` 手动命名的会话
- `reason === "reload"` 的 session_start

### 2.2 Side Agent Prompt

```
你是一个会话命名助手。根据用户的第一条消息，生成一个简短的会话标题。

规则：
- 使用中文
- 不超过 30 个字符
- 直接输出标题，不加引号、不加前缀
- 概括用户意图，不要照搬原话
- 如果消息包含代码相关的关键词，保留关键文件名或模块名

示例：
  用户: "帮我看看 src/auth.ts 里的 token 刷新逻辑为什么报错"
  输出: 调试 auth.ts token 刷新报错

  用户: "写一个 Python 脚本批量重命名照片文件"
  输出: Python 批量重命名照片脚本

  用户: "这个项目的测试覆盖率怎么样"
  输出: 检查项目测试覆盖率
```

设计要点：
- maxTokens: 64（标题很短，不需要更多）
- 不返回 JSON，直接返回纯文本（比 scout 的 JSON 解析更简单可靠）
- 后处理：strip 前后引号、换行、空白，截断到 50 字符

### 2.3 与 pi-scout 的执行关系

session-namer 和 scout 都在 `before_agent_start` 中运行。pi 按扩展加载顺序串行执行 hook handler，所以：

- **加载顺序无关**：两个插件互不干扰——scout 修改 system prompt 和模型，namer 只调 `pi.setSessionName()`
- **不会叠加延迟**：namer 只在首轮触发，后续轮次直接跳过（guard 逻辑开销 < 1μs）
- **首轮延迟**：namer 的 side agent 调用 (~0.5-1s) 与 scout 的 side agent 调用是串行的。但由于只在首轮发生一次，且不阻塞用户感知（命名在后台完成，不影响 agent 响应），可接受

**可选优化**：如果未来 pi 支持并行的 `before_agent_start` handler，两者可以并行跑。

---

## 3. 接入点分析

### 3.1 `pi.setSessionName(name)` 写入后的生效范围

| 位置 | 显示效果 |
|------|---------|
| `/resume` 会话选择器 | 有 name 时显示 name **替代**第一条消息文本 |
| `/resume` Ctrl+N 过滤 | 可切换"仅显示已命名会话" |
| `/resume` Ctrl+N 过滤 | 已命名的会话自动纳入过滤范围 |
| `/session` 命令 | 显示 session name |
| `get_state` RPC | `sessionName` 字段 |
| session.jsonl 文件 | `{"type":"session_info", "name":"..."}` |

**注意**：`setSessionName()` 是幂等的——多次调用会追加 `session_info` entry，`getSessionName()` 取最新一条。所以即使在 `/resume` 恢复的会话中误触发，也只是覆写一个已有的 name，不会产生副作用。

### 3.2 不需要额外接入的地方

- **TUI 标题栏**：pi 没有自动把 session name 设为终端标题的机制。如果需要可以用 `ctx.ui.setTitle()` 额外设置，但这属于锦上添花，v1 不做
- **`/resume` 的搜索**：session name 已经被纳入 `/resume` 的搜索文本，无需额外处理
- **RPC `set_session_name`**：这是 RPC 客户端调用的，与 extension 无关

---

## 4. 配置设计

在 `~/.pi/agent/settings.json` 中：

```jsonc
{
  "sessionNamer": {
    "enabled": true,
    "sideAgentRole": "utility",
    "maxLength": 50
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 全局开关 |
| `sideAgentRole` | `"utility"` | pi-model-roles 中用于命名的 cheap 模型角色 |
| `maxLength` | `50` | 生成名称的最大字符数（超出截断） |

### 配置加载

复用 pi-scout 的配置合并模式：全局 `settings.json` + 项目 `.pi/settings.json`，项目覆盖全局。

---

## 5. 命令设计

| 命令 | 说明 |
|------|------|
| `/namer` | 显示当前状态和配置 |
| `/namer on` / `/namer off` | 全局开关（仅内存，重启恢复 settings.json 值） |
| `/namer:rename` | 立即为当前会话重新生成名称（使用缓存的最后一次用户 prompt） |

---

## 6. 文件结构

```
packages/pi-session-namer/
├── package.json
├── README.md
├── tsconfig.json
└── src/
    ├── index.ts          # Extension 入口，注册事件和命令
    ├── types.ts          # 类型定义和默认配置
    ├── config.ts         # 配置加载（settings.json 合并）
    └── namer.ts          # Side agent 调用和名称生成逻辑
```

### 6.1 types.ts → `src/types.ts`

已实施，与计划一致（22 行）。`language` 字段已移除——标题语言自动跟随用户输入。

### 6.2 config.ts → `src/config.ts`

已实施，复用 pi-scout 的 JSONC 读取 + deep merge 模式（65 行）。

### 6.3 namer.ts → `src/namer.ts`

已实施，包含：
- `buildNamerSystemPrompt()` — 根据配置构建系统提示
- `generateSessionName()` — 调用 side agent 生成名称，失败时 fallback 截断用户 prompt
- `cleanSessionName()` — 去引号、换行、截断
- 长 prompt 截断（>2000 字符）避免浪费 token

（100 行）

### 6.4 index.ts → `src/index.ts`

已实施，与计划骨架基本一致，补充了：
- `lastPrompt` 缓存：`before_agent_start` 中缓存用户 prompt，供 `/namer:rename` 使用
- `/namer on` / `/namer off`：合并到 `/namer` 命令中（通过 args 判断），仅内存切换
- `/namer:rename`：完整实现（读取缓存的 lastPrompt → 解析模型 → 调用 generateSessionName → setSessionName）

（142 行）

---

## 7. 依赖关系

```
pi-session-namer
  ├─ @earendil-works/pi-ai           (peer, optional) — complete() 调 LLM
  ├─ @earendil-works/pi-coding-agent  (peer, optional) — ExtensionAPI
  └─ @d3ara1n/pi-model-roles          (peer, optional + runtime dep) — resolveRoleAsync()
```

与 pi-scout 的依赖结构完全一致。

---

## 8. 性能影响

| 指标 | 值 |
|------|-----|
| 首轮额外延迟 | ~0.5-1s（一次 cheap side agent 调用） |
| 后续轮次延迟 | 0（guard 直接 return） |
| 额外 token 消耗 | ~100 input + ~30 output（首轮一次性） |
| 内存 | 忽略不计（1 个 boolean flag + config 对象） |

注意：首轮的 side agent 调用与 scout 的 side agent 调用是**串行**的（pi 按 handler 注册顺序执行）。如果用户同时启用 scout + namer，首轮会有 2 次 side agent 调用。但由于：
1. 只在首轮发生
2. namer 的调用很轻量（maxTokens: 64）
3. 不阻塞 agent 响应（用户感知不到命名延迟）

这个 trade-off 是可接受的。

---

## 9. 边界情况

| 场景 | 处理方式 |
|------|---------|
| Side agent 调用失败 | 静默 fallback：截断用户 prompt 作为名称 |
| 用户 prompt 为空（纯图片） | 跳过命名，不设置 name |
| `/resume` 恢复已有会话 | `session_start` 中检测 `pi.getSessionName()` 已存在，`hasNamed = true` |
| `/fork` / `/clone` | 同上，会话已有内容，不触发自动命名 |
| 用户手动 `/name` 后 | `hasNamed = true`（`session_start` 时已检测到 name） |
| `--name` 启动 | 同上，`pi.getSessionName()` 已有值 |
| Side agent 返回空/垃圾 | `cleanSessionName()` fallback 到 `"New session"` |
| 非常长的 prompt | 只取前 2000 字符作为 side agent 输入，避免浪费 token |
| 非 TUI 模式（print/rpc/json） | `pi.setSessionName()` 在所有模式下都工作，无需特殊处理 |

---

## 10. 未来扩展

- **动态改名**：随着对话深入，可以用 `agent_end` 在特定轮次后更新 name（如第 3 轮后根据更完整的上下文重命名）
- **多语言自动跟随**：标题语言自动与用户输入一致，无需配置
- **TUI 标题同步**：命名后调用 `ctx.ui.setTitle("pi - " + name)` 设置终端标题
