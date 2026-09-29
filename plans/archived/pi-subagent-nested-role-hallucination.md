# pi-subagent 嵌套委派角色幻觉调查（2026-09-29）

> **用途**：researcher 子代理嵌套委派时把角色名写成 `web-researcher` / `web researcher` 的完整根因记录。三层事故叠加：allowlist 被 agentOverrides 绕过 → 残缺 override 炸掉 guidelines 生成 → 错误被吞导致子代理拿到**空角色表**。修复前本文档是唯一完整记录，勿凭记忆重查。

---

## 1. 现象（用户一手观察）

- 主会话委派 researcher（子代理，depth 1）后，researcher 在**嵌套委派**（depth 2）时把 `subagent_delegate` 的 `role` 参数写成 `web-researcher` 和 `web researcher` 两种形式，均被拒。
- 顶层会话的角色表一切正常；只有嵌套层出错。

## 2. 排除项（已查证，勿重查）

| 假说 | 排除依据 |
|------|----------|
| 角色列表没带进子代理提示词（子代理不是完整 pi 上下文） | **不成立**。子进程是完整 `pi --mode rpc`，加载同一份 settings.json 的 extensions（含 pi-subagent 本身）；RPC 启动 `bindExtensions` → 触发 `session_start`，且在 stdin 命令读取器挂载前 `await` 完成（`rpc-mode.js:289` 早于 `:646`），首次 prompt 前 system prompt 已定稿。`registerTool` 走 `Map.set` 覆盖旧定义，重注册生效 |
| researcher 子代理"猜到 researcher 并违规调用" | 不成立。它猜的是 `web-researcher`/`web researcher`（从自身 role prompt 首行 "Web researcher." 衍生），且真相比违规更糟——见根因 ③：它连合法的 explorer 都看不到，**空表无从违规** |
| `subagent:view` 显示 `delegate` 是另一个命令 | 非缺陷。`utils.ts` `renderToolCall` 的 `case "subagent_delegate"` 故意用紧凑标签（代码注释明说 "Compact display label — the full tool name is subagent_delegate"），活动流行宽受限省一半宽度；主聊天区工具行（`render.ts` `renderDelegateCall`）显示完整名 |

## 3. 根因（三层叠加，均已实测复现）

### ① allowlist 被 `applyAgentOverrides` 绕过

`index.ts` session_start 顺序：先 `refreshAvailableRoles()`（按 `PI_SUBAGENT_ALLOWED` 过滤 BUILTIN_ROLES），后 `applyAgentOverrides()`。被过滤掉的名字若在 `subagent.agentOverrides` 里有**非禁用的部分覆盖**，走 "custom role" else 分支被**整个 override 对象当角色塞回**——绕过 allowlist，且是残缺形态（只有 override 里写的字段）。

用户 settings.json 对 reviewer/researcher 恰有部分覆盖（仅 description/decisionTrigger/tools）。实测（子进程 `PI_SUBAGENT_ALLOWED=explorer`）：

```
after allowlist filter: [ 'explorer' ]
after agentOverrides:   [ 'explorer', 'reviewer', 'researcher', 'advisor' ]
  reviewer   | role: MISSING | systemPrompt: MISSING | examples: MISSING
  researcher | role: MISSING | systemPrompt: MISSING | examples: MISSING
  advisor    | 完整（自定义角色同样完全绕过 allowlist）
```

explorer 本身在 allowlist 内，与 builtin merge 后完整；reviewer/researcher 被整体替换成 partial；advisor 是全字段自定义角色但同样不该进子代理。

### ② 残缺 override 炸掉 guidelines 生成，错误被吞

session_start 的自定义角色校验循环 `if (name in BUILTIN_ROLES) continue` 跳过了 builtin 名——reviewer/researcher 虽是 builtin 名但已被替换成 partial，校验漏过。随后 `buildGuidelines()` 的 `role.examples.map(...)` 对缺 `examples` 的 reviewer 抛 `TypeError: Cannot read properties of undefined (reading 'map')`（实测复现），`registerTools()` 中断。

pi 的 extension runner `emit` 对 handler 错误是 per-handler catch + `emitError`（只进 child stderr，父进程不失败就不显示）——错误静默。

### ③ 子代理保留扩展加载时的空表注册

`registerTools()` 在扩展加载时（`index.ts:997`）也执行过一次，当时 `availableRoles` 为空。session_start 内的重注册炸了之后，工具定义停留在初始版——**"AVAILABLE ROLES:" 一节下面是空的**。子代理面前有一个 delegate 工具、零个合法角色名。

加重矛盾的细节：`execute()` 查的 `availableRoles` 在崩溃前已填充完毕（refresh + overrides 在 registerTools 之前跑完），所以 Unknown role 错误回执写着 `Available: explorer, reviewer, researcher, advisor`——**反馈里有名字，prompt 里却没有表**。弱模型（researcher 用 fast 档 glm-5.3-flash）收到矛盾信号后在名字空间里换拼写打转（`web-researcher` → `web researcher`），两种写法是同一次幻觉的两种拼写，不是两个 bug。

## 4. 波及范围（用户当前配置）

- **researcher 子代理**（allowlist=[explorer]，不含 reviewer/researcher）→ 空表崩溃 ✓
- **advisor 子代理**（allowlist=[explorer,researcher]，不含 reviewer）→ reviewer partial 炸表 ✓
- 顶层会话（无 allowlist，override 正常 merge 成完整角色）→ 正常
- explorer（无 subagentRoles，不下委派）、worker（disabled）→ 不受影响

与"只在嵌套委派时出错"的观察吻合。命中条件一般化：**子代理带 allowlist + agentOverrides 里存在不在 allowlist 内的 builtin 名的部分覆盖**。

## 5. 连带风险（未触发但同根）

若子代理真调了泄漏的残缺 `researcher`：`roleDef.role` 为 undefined → `resolveRoleAsync(undefined)` 落到 defaultRole → 静默用 glm-5.3(medium) 而非 fast 模型，且 systemPrompt 为空串（跳过 `--append-system-prompt`）→ 一次无声的错误模型、无角色指令的运行。

## 6. 修复方向（按根因排序，未实施）

1. **allowlist 绕过（根因）**：override 应用改序——先在 `BUILTIN_ROLES` 全集上 merge，再按 allowlist 过滤；自定义角色在子进程里同样受 allowlist 约束（或至少默认不进）。
2. **残缺 override 炸表**：校验循环对"被 else 分支整体替换成 partial 的 builtin 名"不应豁免（`if (name in BUILTIN_ROLES) continue` 漏掉这种情况）；或 else 分支根本不接受 builtin 名。
3. **静默降级**：修掉 ①② 后 `buildGuidelines` 自然不抛；空表初始注册可顺带加防御（guidelines 为空时 stderr 报错，child stderr 目前只在失败时可见，考虑更显式的通道）。

改动集中在 `packages/pi-subagent/src/index.ts` 的 `refreshAvailableRoles` / `applyAgentOverrides` / session_start 校验循环，约十来行。

## 7. 验证方式备忘

- 复现脚本：node --input-type=module 加载 `BUILTIN_ROLES` + 用户 settings 的 agentOverrides，模拟 allowlist 过滤 → override 应用 → buildGuidelines 循环（见调查过程，输出在本文档 §3①③）。
- 修复后回归点：子进程（PI_SUBAGENT_ALLOWED 设置时）availableRoles 与 allowlist 严格一致；带 partial override 的 builtin 名不再以 partial 进入；buildGuidelines 不抛；顶层会话角色表不变。
