# pi-access-denied：授权弹窗改造方案

> 现状：单条垂直选择，一次只给一个决策。
> 目标：多路径同屏，每条路径独立设操作，减少重复动作。

---

## 现状的两个真问题

读了现有 `index.ts` / `types.ts`：

1. **整体决策**——`promptDecision` 用 `ctx.ui.select` 返回单个 `Decision`，再 `for (const v of violations) remember...` 把**一个选择套到所有路径**。bash 多路径无法逐条差异化。
2. **Esc 误触拒绝**——`askReason` 用 `ctx.ui.input`，dismiss(Esc)/空 都落到 `return { block: true, reason: 默认理由 }`。即 Esc 本意"改主意"，实际"无理由拒绝并提交"。

> 注：记忆层**不需要改造**。现状的 `alwaysAllow: Set<string>` / `alwaysDeny: Map<string,string>` + `paths.ts` 的 prefix coverage **本来就是 per-path 的**。唯一变化是"只有被选 always 的那条才记忆"（per-path 决策的自然结果），记忆机制零改动。

---

## 改造方案

| # | 改造 | 落点 |
|---|---|---|
| 1 | **交互层换实现**：`ctx.ui.select` → `ctx.ui.custom` 自定义面板，贴底部（bottom-center overlay，范式照抄 pi-ask-user 的 `AskUserPanel`） | `promptDecision` |
| 2 | **per-path 决策**：面板返回 `Map<path, Choice>`（`Choice ∈ accept / always-accept / deny / always-deny`），默认值全 `accept` | `promptDecision` 返回类型、`types.ts` 的 `Decision` 改为 per-path |
| 3 | **修复 Esc**：提交含 deny 类时弹**单个全局理由框**，理由可选（Enter=默认）；**Esc=退回路径列表**，不拒绝 | `askReason` 调用点 |
| 4 | **整体裁决**：提交后任一 deny → block 整个调用；`always-*` 按各自 per-path choice 分别记忆；其余按现有 switch 语义 | 主流程 `tool_call` 的 switch |

### 提交后的处理

- **全 accept/always-accept** → 放行；其中 always-accept 的路径分别 `rememberAllowed`。
- **含 deny** → 整体 block；deny-always 的路径分别 `rememberDenied(reason)`；理由用全局理由框取一次。
- **dismissed（Esc 取消整个面板）** → 沿用现有"Authorization dismissed"软拒绝。

理由框是单个全局的：拒绝整体打回，一个理由足够。

### 键位

| 键 | 作用 |
|---|---|
| ↑ / ↓（或 k / j） | 在路径列表间移动焦点 |
| ← / →（或 h / l） | 改当前焦点路径的操作，四选项首尾循环 |
| Enter | 提交 |
| Esc | 取消整个授权（整体打回） |

---

## 实现提示

1. **面板贴底部**：`overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", margin: { bottom: 0 } }`，照抄 `packages/pi-ask-user/src/index.ts` 末尾的 `ctx.ui.custom` 调用。
2. **横向操作条**：组件 `render(width): string[]` 里把四个选项拼进**同一行字符串**即可；高亮用 `theme.fg("accent"/"error"/"success", text)` + `theme.bold()`，未选中用 `theme.fg("dim", text)`。
3. **理由框**：用 pi-tui 的 `Editor`（单行编辑）；键路由 `matchesKey`。
4. **改动集中点**：`packages/pi-access-denied/src/index.ts` 的 `promptDecision` 及调用它的主流程 switch；`types.ts` 的 `Decision` 类型被 per-path choice 取代后删除。
5. **README**：「Authorization dialog options」段同步更新为新面板描述。

---

## 决策记录

- **不改 `paths.ts`**：路径提取、allowlist、记忆逻辑都不变，只改交互层。
- **不做"All"总控旋钮**：与"默认全 accept + Enter 提交"功能重叠，多余。默认 accept 已是最小阻力路径。
- **理由全局单个**：拒绝整体打回，逐条理由是多余的。

---

## 验收要点

1. 多路径 bash → 面板列出全部，默认全 accept。
2. ←/→ 改某条路径的操作；↑/↓ 切路径焦点。
3. 设了 deny 后 Enter → 理由框弹出 → **Esc 应回到列表**（不是直接无理由拒绝）。
4. 全 accept → Enter 直接放行，不弹理由框。
5. `tsc --noEmit` 通过，既有 paths 测试不受影响。
