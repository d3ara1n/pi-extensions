# pi-peek — 跨实例瞥一眼（阅后即焚）

> **状态：待实施** — 由 [`pi-aside`](./archived/pi-aside.md)（已归档）演进而来。
> pi-aside 的核心设计（序列化注入、阅后即焚、utility 模型、入口无关 `investigate()`）
> **全部保留**；本文档在其基础上：
> - **重命名**：`pi-aside` → `pi-peek`（意象从"旁白"改为"瞥一眼/偷瞄"，更贴合跨实例观察的动作）
> - **IPC 改用 Unix domain socket + 轻量 PID-file registry**（纯 `node:net` 零依赖）——
>   原计划曾考虑吸纳 [pi-messenger](https://github.com/nicobailon/pi-messenger) 的文件协调 mesh，
>   经评估**文件协调的清理是固有痛点**（崩溃残留、消息文件生命周期难题），而 peek 是阅后即焚、
>   不需要 pi-messenger 那种持久化（crew 任务/reservation/feed/chatHistory），故改用 UDS
> - **强化等待 UX**：overlay 新增"瞭望台模式"（纯观察不提问，0 等待）+ 阶段进度 + tracker 实时推送

## 想法

多个 pi 实例在跑（同项目多终端、或跨项目协作），提供一种**轻量、不打扰**的跨实例观察通道：

- **用户**：敲 `/peek` 瞥一眼隔壁在干嘛，或提个小问（"你那个 debounce 怎么实现的？"）——
  隔壁主 agent 完全无感，继续干活
- **LLM**（主 agent）：跑任务时想了解隔壁进度，调 `peek` tool 同步问一句——
  答案作为 tool result 回流，融入自己的推理链

**peek**（匆匆一瞥/偷瞄）：温和不猥琐，瞄一眼就走。与原 aside（戏剧"旁白"）同属旁观语义场，
但更强调**跨实例的主动观察**。核心铁律不变：**绝不打扰被观察方的主对话**。

## 核心机制：序列化注入 + UDS 投递（继承 pi-aside + socket 传输）

pi-aside 已论证的**序列化注入模式**原样保留（详见 [archived/pi-aside.md](./archived/pi-aside.md) 的对照表）：

```
investigate(question):                ← pi-aside 核心，入口无关纯函数
  1. 序列化被观察方的主对话分支 → referenceText（纯文本，含工具调用摘要）
  2. complete(streamSimple)(utilityModel, {
       systemPrompt: PEEK_CONSULT_PROMPT,     // peek 自有，不复用主 agent 的
       messages: [{ role: user, content: referenceText + "\n\n" + question }]
     })
  3. 返回答案，丢弃一切（阅后即焚）
```

本文档聚焦的是**跨实例投递层**——怎么把 question 送到隔壁、怎么把答案带回来。
决策：**Unix domain socket（UDS）+ 极轻量 PID-file registry**，纯 `node:net` 零依赖实现。

### 为什么放弃文件协调（吸纳 pi-messenger 的方案被推翻）

曾计划吸纳 pi-messenger 的文件协调 mesh（registry/inbox/replies + `fs.watch`），
评估后放弃。pi-messenger 的 `store.js` 虽然实现了生产级 mesh，但**文件协调的清理是固有痛点**：

| 进程怎么死 | 文件协调 | UDS |
|-----------|---------|-----|
| 正常退出 / `/exit` | `session_shutdown` hook unregister ✅ | fd 关闭，socket 自动失效 ✅ |
| `Ctrl+C` (SIGINT) | 多半能触发 hook ⚠️ | 同上 ✅ |
| `kill -9` / OOM / 段错误 | **hook 不触发，registry+inbox+replies 全残留** ❌ | **内核回收 fd，socket 立即失效** ✅ |
| 断电 / 系统重启 | 残留永久存在，下次启动混进在线列表 ❌ | `/tmp` 清空或 reconnect 失败即知 ❌→✅ |
| 消息文件（inbox/replies） | **谁删？何时删？双方确认？超时？** 协议难题 ❌ | 不落盘，无此问题 ✅ |

pi-messenger 用"惰性清理"（读 registry 时按 `lastSeen` 过滤 stale）是**补丁不是优点**——
它让 stale 条目不显示，但**文件本身不删**（除非额外 sweep），垃圾累积。
**根本原因**：pi-messenger 用文件是因为它要**持久化**（crew 任务、reservation、feed、chatHistory），
惰性清理是为其持久化模型付的代价。peek 是阅后即焚，**不需要持久化**，不该继承这个代价。

UDS 方案的清理由**内核负责**：进程退出（任何方式，含 SIGKILL/崩溃/断电）→ fd 全关 →
socket 立即失效。唯一的"残留"是 socket 文件路径和 registry marker JSON，发现时 PID probe
一行代码清掉（见下文）。

### 术语澄清：UDS 而非 FIFO

"命名管道"严格讲是 POSIX FIFO（`mkfifo`，单向，多写一读）；peek 是双向问答 + 推送，
**Unix domain socket**（`AF_UNIX`，双向，多连接）更合适。下文统一说 UDS。
Node 内置 `net` 模块原生支持：`net.createServer().listen(path)` / `net.connect(path)`，
Linux/macOS 都用 `AF_UNIX`，**零依赖**。

### 为什么不用现成库（调研结论）

调研了两个 UDS 库，均不成熟到值得依赖：
- **`dark1zinn/libunix`**：API 完美契合（request/response + emit + typed events），但
  **1 star / 19 天项目 / 0.1.3 版本 / 单人维护**，进生产依赖风险过大
- **`@kyneta/unix-socket-transport`**：强依赖 `@kyneta/exchange` + `machine` + `wire`
  （CRDT 文档同步框架全家桶），peek 只要"问一句答一句"，杀鸡用牛刀

peek 的 IPC 原语足够简单（问-答 + 推送 + 发现），自写约 80 行零依赖代码（见下文包结构），
完全可控、永不因上游弃坑而坏。

## UDS 天然支持流式（附带红利）

文件协调做流式需"边写边读"（写端 onToken 不断 append，读端 watcher 持续读），比"答完一次写"复杂，
ROI 低。**UDS 天然是流**：`streamSimple()` 的 `onToken` 直接 `socket.write(chunk)`，
对端 `socket.on('data')` 喂给 overlay 渲染。**v1 即流式，无 v2 纠结**。

## 三包架构

沿用 monorepo 已验证的 [`pi-model-roles`](./archived/model-roles-and-skill-router-v2.md) 模式
（globalThis 状态 + `getPeekAPI()` + `session_start` 初始化 + 消费者 import 类型）。

```
packages/pi-peek/           核心库（不注册工具/命令，只提供能力 + 注册 hook）
  ├─ serialize.ts     ~80行  序列化主对话 → referenceText（继承 pi-aside，格式+截断）
  ├─ investigate.ts   ~60行  入口无关核心: 序列化 + complete/stream + 自有 system prompt
  ├─ tracker.ts       ~50行  主 agent 状态快照（hook 驱动，存 globalThis）
  ├─ ipc.ts           ~50行  [新] UDS server/client + JSON-per-line 分帧 + request/response 关联 + emit
  ├─ discovery.ts     ~40行  [新] PID-file registry + kill(pid,0) 验活 + socket 试探 + 清理
  ├─ api.ts           ~40行  getPeekAPI() / initPeekAPI()（globalThis 单例）
  ├─ types.ts         ~30行  PeekAPI / PeerInfo / AskOptions 等
  └─ index.ts         ~30行  session_start 初始化 + 注册 tracker hook + 起 ipc server

packages/pi-peek-user/      用户入口（TUI overlay）
  ├─ overlay.ts      ~200行 overlay 组件（瞭望台面板 + 提问 + 等待 UX + 多轮）
  ├─ session.ts       ~50行 overlay 自维护 messages 累积（不碰主 session）
  └─ index.ts         ~40行 /peek 命令 + Alt+/ 焦点切换

packages/pi-peek-agent/     LLM 入口（同步 tool）
  ├─ tool.ts         ~60行  peek tool（connect 对方 socket → request → 等 response → 返回 tool result）
  └─ index.ts         ~30行 注册 peek tool
```

**入口无关设计**（继承 pi-aside）：`investigate()` 是纯函数，签名不依赖任何 UI/IPC 形态。
peek-user（overlay）和 peek-agent（tool）共用同一个 `getPeekAPI()`，核心零重复。

## 发现机制（PID-file registry + socket 验活）

借鉴 [Claude Code 的 `udsClient.ts`](https://github.com/claude-code-best/claude-code/blob/91cffe16/src/utils/udsClient.ts)
和 [mcpfusion 的 TelemetryBus](https://github.com/vinkius-labs/murb.ts) 的生产级做法：
**极轻量 PID-file registry**（只存地址，不存数据）+ **socket ping 验活**。

### 目录布局

```
~/.pi/peek/                              ← 极轻 registry，只存"地址锚"，不存消息数据
  registry/
    <sessionId>.json    每实例一条 marker（几百字节）
                         { sessionId, pid, sockPath, name, cwd, gitBranch, model, since, lastSeen }

/tmp/pi-peek-<sessionId>.sock            ← UDS 路径（进程死=socket 自动失效，残留文件 connect 失败即清）
```

**与 pi-messenger 文件协调的关键区别**：registry 只存**地址索引**（sockPath + pid），
不存 inbox/replies 数据目录。就算残留，下次发现时 PID probe（读个 pid 字段 + `kill(pid,0)`）
O(1) 清掉，不用扫描消息目录。

### registry marker 格式

```typescript
interface PeerInfo {
  sessionId: string;        // 实例唯一标识（crypto.randomUUID()，非 pid）
  pid: number;              // 用于验活（kill(pid,0) 失败=进程已死）
  sockPath: string;         // UDS 路径，connect 用
  name: string;             // PI_PEEK_NAME 环境变量，或形容词+名词随机（如 "Fox"）
  cwd: string;              // 工作目录（项目归属，用于分组）
  gitBranch?: string;       // git 分支（同项目消歧）
  model: string;            // 当前主模型
  since: string;            // session 开始时间（算"已工作多久"）
  lastSeen: string;         // ISO 时间戳，心跳刷新（socket 验活为主，lastSeen 为辅）
}
```

### 发现流程

```typescript
async function listPeers(): Promise<PeerInfo[]> {
  const files = fs.readdirSync(registryDir).filter(f => f.endsWith(".json"));
  const peers: PeerInfo[] = [];
  for (const f of files) {
    const info = JSON.parse(fs.readFileSync(join(registryDir, f), "utf8"));
    // PID 验活：进程还在吗？
    if (!isPidAlive(info.pid)) { unlinkSync(...); continue; }   // stale，顺手清
    // Socket 验活：socket 还能连吗？（pid 活但 socket 没起=启动中或异常）
    if (!(await canConnect(info.sockPath))) { continue; }
    peers.push(info);
  }
  return peers;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }   // 信号 0 = 只检测不真发
  catch { return false; }                       // ESRCH = 进程不存在
}
```

**双层验活**（Claude Code 同款）：`kill(pid,0)` 确认进程在 + `connect` socket 确认服务起。
比 pi-messenger 单靠 `lastSeen` 时间戳可靠得多——时间戳无法区分"进程死了"和"进程在但心跳慢了"。

### 心跳

socket 长连接可选（v1 用请求-响应，不维持长连接），所以心跳退化为：
`setInterval` 每 15s 重写 registry marker 的 `lastSeen`。**但 socket 验活是主**，
`lastSeen` 只是辅助（比如对方还没起 socket 时的"最近还活着"信号）。

### 同项目多实例怎么区分（pi-messenger 没解决的问题，peek 改进）

pi-messenger 对同项目多实例**不去重**，靠 `cwd + gitBranch` 附加信息消歧，但 `list` 时不分组。
peek 改进：

1. **registry 强制带 cwd + gitBranch**，overlay/tool 的 `list` 按 cwd 分组：
   - **本项目**（cwd 匹配）高亮置顶
   - **其他项目**灰显折叠
2. **`at` 参数三粒度定位**（tool 和 overlay 共用）：

```typescript
peek({ at: undefined })        // 省略 → 自动选同 cwd 的"另一个"在线实例（最常见场景）
peek({ at: "Fox" })            // name；同名多个 → 返回候选列表让调用方澄清
peek({ sessionId: "abc…" })    // 精确锁定（name 冲突时用）
peek({ action: "list" })       // 先看谁在线（按 cwd 分组返回）
```

3. **name 冲突检测**：`listPeers()` 发现同名（不同 sessionId）时标记 `ambiguous: true`，
   `peek({at:"Fox"})` 命中歧义则返回所有同名 peer 的 `{sessionId, gitBranch, since}` 让调用方二次选。

## 通信管道（ipc.ts）

### IPC 协议（JSON-per-line 分帧）

每条消息一行 JSON（`\n` 分隔），三种类型：

```typescript
// 客户端 → 服务端
{ kind: "request",  id: "req-1", type: "ask",     data: { question: "..." } }   // 问-答
{ kind: "request",  id: "req-2", type: "ping",    data: null }                  // 验活
// 服务端 → 客户端
{ kind: "response", id: "req-1",                    data: { answer: "..." } }   // 对应 request
{ kind: "emit",     type: "status",                 data: <trackerSnapshot> }   // 推送（无 id）
```

**request/response 关联**：客户端发 request 时记下 `{id, resolve, reject}` 到 pending map，
收到 response 时按 id 取出 resolve。超时（默认 30s）自动 reject。

### 投递流程（不打扰接收方主 agent）

```
发起方（B）                              接收方（A）
─────────                              ─────────
peek({at:"A", question})
  │
  ├─ listPeers() 找到 A，拿 sockPath
  ├─ net.connect(A.sockPath) ──────────▶  server.on('connection') 收到
  │                                         │
  │                                         ├─ emit('status', tracker) ──▶ B  (立即：A 此刻在干嘛)
  │                                         ├─ socket.write({request:'ask', question})
  │                                         ├─ getPeekAPI().investigate(question, {
  │                                         │     onToken: chunk => socket.write({emit:'token', chunk})  // 流式!
  │                                         │   })
  │                                         │     （utility 模型，不打扰 A 主 agent）
  │                                         └─ socket.write({response, answer})
  │
  ├─ on('data'): emit('status') → overlay 即时显示 "A 此刻: ⚙ bash npm test"
  ├─ on('data'): emit('token')  → overlay 流式渲染答案
  ├─ on('data'): response       → 完成
  └─ 返回（tool: 作为 tool result / overlay: 渲染到对话区）
```

**关键**：A 的主 agent 全程无感——investigate 是 pi-ai 的 `complete()` 纯函数，
不碰 A 的 session，不 steer，不创建任何 session 文件（继承 pi-aside 的阅后即焚保证）。

### 阶段反馈（协议层，非文件标志位）

文件协调方案要写 `status:received|investigating|done` 标志位到文件让对端 watcher 读；
socket 方案直接用协议消息：

| 阶段 | 实现 | 何时发 |
|------|------|--------|
| 已连接 | `emit('status', tracker)` | connection 建立后立即（含"此刻在干嘛"） |
| 调查中 | `emit('stage', 'investigating')` | investigate() 调用前 |
| 流式回答 | `emit('token', chunk)` | `streamSimple` 的每个 onToken |
| 完成 | `response({answer})` | investigate() 返回 |
| 失败 | `response({error})` | 异常时 |

## 等待 UX 强化（pi-peek-user 重点）

pi-aside 原设计的 overlay 只有"提问→等→显示答案"，等待期空白。
peek-user 利用三个**即时信息源**（不需要等 LLM）消除等待焦虑：

1. **tracker 即时快照**：connection 建立后服务端立即 `emit('status')` 推送（0 延迟，非轮询）
2. **阶段进度**：协议层的 stage/emit 消息实时反馈问题到哪了
3. **流式 token**：`emit('token')` 让答案逐字浮现（UDS 天然支持，文件方案做不到）

### 瞭望台模式（/peek 无参 = 纯观察，0 等待）

`/peek` 不带参数 → 不提问，只显示在线 peer 状态面板。**完全规避等待问题**——纯本地 listPeers()，
watcher 监控 registry 目录变化自动重绘（新实例上线/下线即时反映）。这是"瞥一眼"最纯粹的形态：
瞄一眼就走，啥也不问。

```
┌─ peek · 瞥一眼 (ESC关闭 · Alt+/切焦点) ──────────────────────┐
│                                                              │
│  ◉ 在线 peer · 3 个                            [r] 刷新       │
│  ── 本项目 (auth-service) ─────────────────────────────────  │
│  ◉ Fox        fix/token-refresh                              │
│    └ ⚙ bash: npm test  · 第3工具  · 已工作 4m23s             │ ← tracker 即时
│  ○ Badger     main                                           │
│    └ 💤 idle · 刚完成 turn · 已工作 12m                       │
│  ── 其他项目 ──────────────────────────────────────────────  │
│  ○ Hare        web-ui (另一项目)                              │
│    └ ⚙ read: src/App.tsx · 第7工具                            │
│                                                              │
│  ──────────────────────────────────────────────────────────  │
│  > 向 Fox 提问（回车发送，留空则纯瞭望）: _                    │
└──────────────────────────────────────────────────────────────┘
```

### 提问后的等待视图（阶段进度 + 流式 + tracker 持续推送）

提交问题后，overlay **立即**收到 `emit('status')`（A 的 tracker 快照，0 延迟），
随后阶段消息和流式 token 持续到达——等待期全程有信息流：

```
┌─ peek · 瞥一眼 ──────────────────────────────────────────────┐
│                                                              │
│  📡 问 Fox · "debounce 实现原理?"                             │
│                                                              │
│     阶段: 🔍 Fox 正在调查…  (3.2s)                            │ ← 阶段进度+计时
│     ─────────────────────────────────────────────────       │
│     Fox 此刻: ⚙ bash: npm test · 第4工具                      │ ← tracker 推送(实时)
│     （Fox 主 agent 在继续干活，你的问题由它身边的 peek 处理）   │
│     ─────────────────────────────────────────────────       │
│     Fox 答: debounce 用了 requestAnimationFrame，在          │ ← 流式逐字浮现
│     useEffect 的 cleanup 里 cancelAnimationFrame             │
│     防止卸载后触发…▌                                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

阶段随协议消息变化：`📡 连接中 → ✉️ 已送达 Fox → 🔍 Fox 正在调查 → 💬 收到回复`。
等待期间 Fox 的 tracker 还在变（它主 agent 继续跑），通过 `emit('status')` 持续推送——
这本身就是"瞥一眼"的持续价值，即使答案还没回。

> **socket 相对文件的额外红利**：文件方案下 tracker 只能靠读 registry 的 15s 心跳快照（延迟高、
> 是轮询）；socket 方案下接收方可主动 `emit('status')` 推送，实时性高一个量级。

### 收到回复后

```
│  ✅ Fox 回复了 (用时 5.3s)                                    │
│  ─────────────────────────────────────────────────────────   │
│  Fox: debounce 用了 requestAnimationFrame，在 useEffect       │
│  的 cleanup 里 cancelAnimationFrame 防止卸载后触发…            │
│                                                              │
│  > 追问: 那卸载时立即调用呢? _                                 │ ← 多轮（不重新序列化）
└──────────────────────────────────────────────────────────────┘
```

多轮 QA：overlay 自维护 messages 数组（继承 pi-aside 设计，不碰主 session），首轮注入 referenceText，
后续轮只追加新问题，省钱省时。退出 overlay 即丢弃整个数组（阅后即焚）。
多轮走同一 socket 连接（peek-user 可选保持长连接复用；peek-agent 每问即连即断）。

### UX 要素清单

| 要素 | 作用 | 实现 |
|------|------|------|
| 瞭望台模式 | 0 等待纯观察 | `/peek` 无参 → listPeers() + watcher 监控 registry |
| 即时占位 | 连接后立刻有内容 | `emit('status')` tracker 推送（0 延迟） |
| 阶段进度 | 知道问题到哪了 | 协议层 stage emit |
| 流式答案 | 逐字浮现 | `emit('token')` + UDS 天然流 |
| elapsed 计时 | 量化等待 | `Date.now() - startTime` |
| tracker 持续推送 | 等待中也有信息流 | `emit('status')`（socket 推送，非轮询） |
| 多轮追问 | 不重复序列化 | overlay 自维护 messages（继承 pi-aside） |

## peek-agent tool 设计

给 LLM 用的同步 tool：调一次，阻塞等答案，作为 tool result 回流到主 agent 推理链。

```typescript
pi.registerTool("peek", {
  description: "瞥一眼隔壁 pi 实例在干什么，或向它提个问（不打扰它）。用于跨实例协作时了解进度/原理。",
  parameters: Type.Object({
    at: Type.Optional(Type.String({ description: "目标实例 name；省略则自动选同项目的另一个实例" })),
    sessionId: Type.Optional(Type.String({ description: "精确锁定（name 冲突时用）" })),
    question: Type.String({ description: "要问的问题" }),
    action: Type.Optional(Type.String({ description: "'list' = 列出在线实例（按项目分组）" })),
  }),
  execute: async ({ at, sessionId, question, action }, ctx) => {
    const api = getPeekAPI();
    if (action === "list") return formatPeerList(await api.listPeers());
    const peer = await api.resolvePeer({ at, sessionId });
    if (!peer) return { error: "没有在线的隔壁实例" };
    if (Array.isArray(peer)) return { ambiguous: true, candidates: peer };  // name 冲突
    const answer = await api.askPeer(peer, question);  // connect → request → 等 response → 断开
    return { from: peer.name, answer };
  },
});
```

**peek-agent 每问即连即断**（无状态连接）：tool 本就是"等完返回 result"的语义，无需保持长连接。
peek-user 则可选保持长连接复用多轮 + 收 tracker 推送（见上）。

## 序列化策略（继承 pi-aside，原文保留）

来源：`ctx.sessionManager.getBranch()` → 当前分支的 `SessionEntry[]`。

### 格式

```
## 用户
<user message text>

## 助手
<assistant text content>

### 工具调用: bash
$ <command>
→ <result, 截断到 500 字符 head200+tail200>

## 用户
<next user message>
...
```

### 截断策略

1. **单条 tool result** > 500 字符 → head 200 + tail 200 + `[truncated]`
2. **整体序列化** > 50k 字符 → 取最近 N 轮（默认 10 轮 user+assistant）
3. **超长 assistant thinking** → 默认丢弃

配置走 settings.json 的 `peek` 块。

## 模型选择：utility role（继承 pi-aside）

硬依赖 [`pi-model-roles`](./archived/model-roles-and-skill-router-v2.md)——peek 不自己配模型，
复用 `utility` role（便宜、快、thinking off）：

```typescript
const rolesApi = getModelRolesAPI();
const resolved = await rolesApi.resolveRoleAsync("utility");
// v1 直接 streamSimple()（UDS 天然流式，无理由不用流式）
```

## peek 自有 system prompt（继承 pi-aside）

不复用主 agent 的 system prompt。peek 用专用咨询助手 prompt：

```
你是 peek，一个编程咨询助手。下面是一场编码助手与用户的对话记录（已序列化为文本）。
请基于这段记录回答问题。

规则：
- 你只负责解释、澄清、咨询，不执行任何操作（你也无法执行）
- 严格基于记录作答；记录中未提及的，明确说"记录中未提及"，不要编造
- 回答简洁精准，聚焦问题本身
```

## 依赖的 API（均已验证可用）

| 能力 | API | 验证来源 |
|------|-----|---------|
| 读主对话分支 | `ctx.sessionManager.getBranch()` → `SessionEntry[]` | pi example、pi-aside 已验证 |
| 流式 LLM 推理 | `streamSimple()` from `@earendil-works/pi-ai` | pi-ai d.ts 已验证 |
| 非流式（备用） | `complete()` from `@earendil-works/pi-ai` | pi-subagent/session-namer 已用 |
| 解析 utility 模型 | `getModelRolesAPI().resolveRoleAsync("utility")` | pi-subagent 已用 |
| 主 agent 状态追踪 | `agent_start`/`tool_execution_*`/`turn_end` hook | extensions.md 已验证 |
| overlay UI | `ctx.ui.custom({ overlay:true, overlayOptions })` | pi-subagent overlay、extensions.md 已验证 |
| overlay 焦点切换 | `OverlayHandle.focus()` / `Alt+/` | tui.md Pattern 7 已验证 |
| 多包状态共享 | globalThis + `getPeekAPI()` | pi-model-roles 已验证 |
| **UDS server/client** | `node:net`（`createServer().listen(path)` / `connect(path)`） | Node 内置，Claude Code/mcpfusion 生产级验证 |
| **进程验活** | `process.kill(pid, 0)`（信号 0 只检测不真发） | POSIX 标准，Node 内置 |
| **registry 变化感知** | `fs.watch(registryDir)` | Node 内置 |

无未知 API，无外部运行时依赖，无架构风险。

## 实现路径

### 实现顺序

1. `pi-peek` 核心继承件：serialize → investigate → tracker（从 pi-aside 设计移植）
2. `pi-peek` IPC 件：ipc.ts（server/client/分帧/request-response/emit）→ discovery.ts（registry/验活/清理）
3. `pi-peek` api + index（globalThis 装配 + session_start 起 server + 注册 hook）
4. `pi-peek-agent` tool（同步，每问即连即断，先做先验证管道）
5. `pi-peek-user` overlay（瞭望台 + 提问 + 流式等待 UX + 多轮，最复杂放最后）
6. 用户 `/reload` 后实测（按 AGENTS.md，扩展改动需手动重载）

### settings.json 加载

```jsonc
{
  "extensions": [
    "/Users/chien/Projects/pi-extensions/packages/pi-peek",
    "/Users/chien/Projects/pi-extensions/packages/pi-peek-user",
    "/Users/chien/Projects/pi-extensions/packages/pi-peek-agent"
  ],
  "peek": {
    "recentTurns": 10,           // 序列化截断的最近轮数
    "maxChars": 50000,           // 整体序列化字符上限
    "toolResultLimit": 500,      // 单条 tool result 截断阈值
    "registryDir": "~/.pi/peek/registry",  // registry 目录（可选覆盖）
    "heartbeatMs": 15000,        // registry lastSeen 刷新间隔（socket 验活为主）
    "askTimeoutMs": 30000        // askPeer 同步等待超时
  }
}
```

## 与 pi-aside / pi-whisper 的演进关系

| 版本 | 核心 | 状态 |
|------|------|------|
| pi-whisper（最早） | fork 主 prefix 吃缓存 + 依赖 sidekick 常驻 | ❌ 推翻（fork 三死结 + sidekick 搁置）→ [archived](./archived/pi-whisper.md) |
| pi-aside | 序列化注入 + utility 模型 + 阅后即焚 + overlay + socket IPC | ✅ 核心保留 → [archived](./archived/pi-aside.md) |
| pi-aside（曾拟） | 吸纳 pi-messenger 文件协调 mesh | ❌ 推翻（文件清理固有痛点） |
| **pi-peek（本文档）** | pi-aside 核心 + UDS 传输（纯 node:net） + 强化等待 UX | 📍 待实施 |

pi-aside 论证的核心设计（为什么放弃 fork、为什么序列化注入、为什么 utility 模型）详见
[archived/pi-aside.md](./archived/pi-aside.md)，本文档不重复，只记录**增量决策**：

- **命名**：aside(旁白) → peek(瞥一眼)。旁白偏"解说"，peek 更主动——跨实例**主动观察**是新增能力
- **IPC（关键修正）**：pi-aside 原计划 unix domain socket → 中途考虑吸纳 pi-messenger 文件协调
  （为白嫖发现/心跳）→ 评估后发现文件清理是固有痛点（崩溃残留、消息生命周期难题），
  而 peek 不需要 pi-messenger 的持久化 → **回归 UDS + 轻量 PID-file registry**（Claude Code 同款方案）
- **等待 UX**：pi-aside 的 overlay 等待期空白 → peek-user 加瞭望台模式 + 阶段进度 + tracker 推送 + 流式
- **流式**：UDS 天然流式，v1 即支持（无文件方案的边写边读复杂度）

## 未决/可演进项

- **多播提问**：`peek({at:["Fox","Badger"], question})` 同时问多个实例，答案聚合显示
- **sidekick tab 入口**：等 pi 开放布局接口（pi-sidekick 复活），peek-user 额外注册常驻 tab
- **跨主机**：UDS 限同机；跨主机需 TCP/WebSocket（架构留口，`investigate()` 入口无关，IPC 层可换）
- **常驻 mesh（v2 可选）**：当前请求-响应为主、emit 预留推送。若未来需要高频双向同步
  （多实例协同编辑），可升级为常驻长连接 mesh（类 libunix 的 connect-or-listen 协商）
- **模型选择可配置**：当前固定 utility role，未来可加配置项允许切到主对话模型（超复杂推理问题）
