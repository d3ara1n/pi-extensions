# pi-todo — 双端可编辑、常驻 context 的任务列表（已归档）

> **状态：已归档（2026-09-30）— 放弃实施**。评估结论：todo 列表对模型和用户的效率提升有限，不值得投入。
> 设计本身已定稿，若日后推翻该结论可从 git history 恢复本计划继续实施。
> 旧版 sidekick 侧栏方向更早前已归档至 [`archived/pi-todo-sidekick.md`](../archived/pi-todo-sidekick.md)。

## 背景与动机

现装 `@juicesharp/rpiv-todo` 提供了 `todo` 工具 + 只读 overlay 面板 + 只读 `/todos` 命令。两个痛点：

1. **列表不常驻**：todo 状态只存在于工具调用的快照里。长会话中（尤其 compaction 后），agent 对"还有哪些事没做完"的感知会漂移，用户需要反复提醒。
2. **用户只能看不能改**：补充约束类任务（"别忘了跑测试"）、勾掉 agent 漏标的完成项、删掉方向变了的任务，都只能打字让 agent 代劳——打断节奏、多一轮对话。

**目标**：todo 列表以 `<todos>` 块**常驻注入 context**（每轮可见，永不遗忘）；**人和 agent 都能编辑**；**会话级持久**（`/reload`、compaction 后恢复）；用户编辑走文本命令按 `#id` 引用。

注：最初讨论的"注意事项常驻 context"需求，经澄清后收敛为 todo 项本身常驻注入——一条 `- [ ] 记得跑测试` 即天然实现"给 agent 挂注意事项"，无需独立 notes 功能。

## 范围

- 新包 `packages/pi-todo`（`@d3ara1n/pi-todo`），**替换** rpiv-todo：从 settings.json 卸载 `npm:@juicesharp/rpiv-todo`，避免两个扩展同名注册 `todo` 工具冲突。
- 本期不做 overlay 面板（rpiv 的形态，二期可选）；用户侧用文本命令。
- 状态机对齐 rpiv 语义（pending → in_progress → completed，deleted 为 tombstone），agent 端工具与用户命令共用同一 reducer。

## 架构

三层，各自独立：

```
┌─ 状态层 ─────────────────────────────────────────────────┐
│  全量快照 TaskState { tasks: Task[], nextId }            │
│  · agent 变更 → todo 工具返回 details（pi 自动存         │
│    toolResult entry，rpiv 同款机制）                     │
│  · 用户变更 → /todo 命令走同一 reducer，然后             │
│    ctx.sendMessage({ customType: "todo",                 │
│      content: 变更摘要,                                  │
│      details: { tasks, nextId } }) 落 session            │
│  · session_start 时从 session branch replay，            │
│    last-write-wins（识别 toolResult 与 custom 两种 entry）│
└──────────────────────────────────────────────────────────┘
┌─ 注入层 ─────────────────────────────────────────────────┐
│  before_agent_start：内存状态渲染成                      │
│    <todos>                                               │
│    - [ ] #1 有东西没做完                                 │
│    - [x] #2 已完成                                       │
│    </todos>                                              │
│  追加到 systemPrompt 末尾——每轮现拼，永远最新，          │
│  不累积、compaction 免疫                                 │
└──────────────────────────────────────────────────────────┘
┌─ 交互层 ─────────────────────────────────────────────────┐
│  LLM：todo 工具（list/get/create/update/delete/clear）    │
│  用户：/todo、/todo add <text>、/todo done <id>、         │
│        /todo undo <id>、/todo rm <id>                    │
└──────────────────────────────────────────────────────────┘
```

## 关键决策与理由

### D1. 注入用 `before_agent_start` 现拼 systemPrompt，不用持久 message

- 用 `ctx.sendMessage` 注入持久消息的问题：每次编辑都新增一条常驻消息，改 10 次 context 堆 10 份旧列表；compaction 还可能吃掉或失真。
- `before_agent_start` 每轮重新生成 systemPrompt（pi 对每条用户消息触发一次），天然只有最新一份。
- 副作用：todo 变更会使 systemPrompt 变化、失效一次 prompt cache。todo 变更低频，可接受；todo 不变时 systemPrompt 稳定，缓存友好。
- 已完成项以 `- [x]` 形式保留在列表里（**全部注入**，用户已确认），agent 能看到完整进度、避免重复工作。

### D2. 用户编辑必须落 session（rpiv 方法），content 只写摘要

- 用户编辑后仅改内存的话，`/reload` 后 replay 恢复不到（session 里没有记录）。所以命令与工具调用一样，把**全量快照**写进 branch。
- 两种 entry 同形状：toolResult（`role="toolResult", toolName="todo"`）与 custom message（`role="custom", customType="todo"`），replay 取最后一个（last-write-wins）。
- `content` 只写一句话摘要（"User marked #3 done"），不重复整个列表——列表新鲜度由注入层保证，避免 context 膨胀。摘要消息同时是 agent 获知"用户改了 todo"的途径。

### D3. 编号引用

- 自增 `nextId`，永不复用（删除是 tombstone 而非物理删除，与 rpiv 一致，保证历史引用稳定）。
- 渲染与命令统一带 `#id`：`- [ ] #3 写测试`、`/todo done 3`。

## 数据模型

```typescript
type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

interface Task {
  id: number;            // 自增，永不复用
  subject: string;       // 任务文本
  status: TaskStatus;
  activeForm?: string;   // in_progress 时的进行时标签（agent 维护）
}

interface TaskState {
  tasks: Task[];
  nextId: number;
}
```

状态机（reducer 纯函数，非法迁移返回 error op）：
- `pending → in_progress` / `pending → completed` / `in_progress → completed`
- `completed → pending`（undo）、任意 → `deleted`（tombstone）
- `deleted` 不可复活（只出现在 list 的 includeDeleted 视图里）

## 工具与命令

### todo 工具（LLM 侧，TypeBox schema）

```
action: list | get | create | update | delete | clear
create:  { subject, status?, activeForm? }
update:  { id, subject?, status?, activeForm? }
```

- 工具描述与 promptGuidelines 沿用 rpiv 语义（3+ 步才用、开始时 in_progress、完成立即标记等），保证 agent 行为不变。
- 每次调用返回 `{ content: 文本结果, details: { action, params, tasks, nextId } }`——details 即持久快照。

### /todo 命令族（用户侧）

| 命令 | 行为 |
|------|------|
| `/todo` | 打印全量列表（按状态分组，含 `[done]` 计数） |
| `/todo add <text>` | 新建 pending 项，返回分配的 `#id` |
| `/todo done <id>` | pending/in_progress → completed |
| `/todo undo <id>` | completed → pending |
| `/todo rm <id>` | 任意状态 → deleted |

- handler 签名 `(args: string, ctx)`，命令内自行解析子命令与参数。
- 执行流程：解析 → reducer 变更内存 → `ctx.sendMessage` 落快照 → `ctx.ui.notify` + 打印确认（含新列表）。
- 输出格式与渲染层共用（`render.ts`）。

## 包结构

```
packages/pi-todo/
  src/
    index.ts     # 注册入口：todo 工具 + /todo 命令 + before_agent_start + session_start replay
    types.ts     # Task / TaskState / TodoParamsSchema（TypeBox）
    reducer.ts   # 纯函数状态机 + 校验（可测，不依赖 pi 运行时）
    replay.ts    # 从 session branch 重建 TaskState（可测，只依赖 getBranch 形状）
    render.ts    # <todos> 注入块渲染 + 命令/工具输出格式（可测）
    store.ts     # 会话内存单例（module-level Map，按 sessionId 隔离，同 rpiv）
  package.json   # "pi": { "extensions": ["./src/index.ts"] }；keywords: pi-package, pi
  README.md      # Installation / Dependencies / 命令与工具说明
```

- 纯函数层（reducer/replay/render）用 `node:test` 单测，不依赖 pi 运行时；store/index 靠类型 + 集成验证。
- 跨包依赖无（不依赖 pi-* 包），`dependencies` 只有 `pi-ai`（TypeBox/类型，peer 随 pi 提供，不写入）。

## 测试计划

| 层 | 用例 |
|----|------|
| reducer | 各状态迁移合法/非法；id 分配；delete 后 id 不复用；error op 形状 |
| replay | 空 branch → EMPTY；只认 toolResult；只认 custom；两种混存取最后；坏形状跳过 |
| render | 空列表；混合状态；id 渲染格式；<todos> 块格式 |
| 集成（手动） | 工具调用 → 面板可见；/todo done 后 sendMessage 落库；/reload 后 replay 恢复；compaction 后状态仍在 |

## 实施步骤

1. **状态层**：types / reducer / store / replay + 单测（不依赖 pi，纯 TDD）。
2. **注入层**：`before_agent_start` 渲染 `<todos>` 追加 systemPrompt。
3. **工具层**：注册 `todo` 工具，details 落快照；renderCall/renderResult 基础渲染。
4. **命令层**：`/todo` 命令族，reducer + sendMessage + notify。
5. **替换 rpiv-todo**：settings.json 移除 `npm:@juicesharp/rpiv-todo`，加载新扩展；手动验证工具/命令/注入/重载/compaction 全链路。

## 风险与开放问题

1. **compaction 是否吃掉旧快照**（待实测）：快照存在 session 历史里，若 compaction 把很旧的 toolResult/custom message 总结掉，`/reload` 后 replay 可能丢状态。rpiv 声称 survive compaction（其 guidance 如此宣称），需验证机制是否同样覆盖 custom message。若丢失，fallback 是 snapshot 文件（牺牲分支语义）或依赖注入层的 systemPrompt 每轮兜底（注意：systemPrompt 不落 session，`/reload` 后内存需重建——仍依赖 replay）。
2. **工具/命令命名冲突**：卸载 rpiv-todo 后无冲突；若用户暂不想卸载，需先解决（不在本期范围）。
3. **custom message 的 context 膨胀**：每次用户编辑多一条摘要消息，低频可接受；compaction 会总结旧消息。
4. **agent streaming 期间用户编辑**：`sendMessage` 默认 `deliverAs: "steer"` 在当轮 tool calls 结束后送达，语义正确（agent 不会打断，但下轮即知）。
5. **多会话隔离**：store 按 sessionId 分区（同 rpiv），子会话/并行会话互不覆盖。
