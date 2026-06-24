# Pi Extensions Monorepo

> 本仓库是 **pi**（coding agent harness，npm 包 `@earendil-works/pi-coding-agent`）的插件集合——所有 `@d3ara1n/pi-*` 插件都在此开发与发布。
>
> 调查某个 `pi-xxx` 插件时，判断流程：
> 1. **先到 `packages/` 目录确认**是否是本仓库开发的插件（本仓库插件均为 `@d3ara1n/pi-*`）
> 2. 在 `packages/pi-xxx/` 找到 → 直接读源码，这是源头，联网搜只会绕路
> 3. 没找到 → 是第三方插件，联网搜或读 `node_modules/`
> 4. **不确定就问用户这是哪个插件、是不是本地的——问用户不丢人**，比猜错绕路强

## 仓库结构

```
packages/        各插件包——每个子目录 = 一个独立发布的 npm 包
  pi-xxx/          目录名即包名（@d3ara1n/pi-xxx）
plans/           设计文档
publish.{js,sh}  发布脚本
```

同一个插件在不同位置用同一个名字（后两项会做变形）：

| 位置 | 形式 | 示例（pi-scout） |
|------|------|------------------|
| 仓库目录 | `pi-xxx` | `packages/pi-scout` |
| npm 包名 | `@d3ara1n/pi-xxx` | `@d3ara1n/pi-scout` |
| commit scope | `(pi-xxx)` | `(pi-scout)` |
| settings.json 扩展路径 | 目录绝对路径 | `.../packages/pi-scout` |
| settings.json 配置字段 | 去 `pi-` 前缀转 camelCase | `scout` |

---

## Commit 规范

所有 commit 必须使用 Conventional Commits 格式：

```
<type>(<scope>): <description>
```

- **type**: `feat` | `fix` | `chore` | `docs` | `refactor` | `style` | `test`
- **scope**: 包目录名，如 `pi-context-include`
- 破坏性变更加 `!` 后缀：`feat(pi-context-include)!: 改了配置格式`

- **未经用户明确同意，禁止自行提交。** 改动完成后展示 diff 或摘要，等用户确认"提交"后再执行 `git commit`。即使改动很小（README 修正等），也先展示再等确认

### 示例

```
feat(pi-context-include): 支持嵌套 @ 引用
fix(pi-context-include): 修复 ~ 路径展开在 Windows 上的问题
chore: 更新依赖
docs(pi-context-include): 补充 README
```

### 版本发布

push 到 main 后 GitHub Actions 自动发布，规则：
- `feat` → minor
- `fix` → patch
- `!` 或 `BREAKING CHANGE` → major
- 其他类型不触发发布

---

## 开发规范

### 安装与加载

在 `~/.pi/agent/settings.json` 的 `extensions` 数组中添加包目录的绝对路径：

```jsonc
{
  "extensions": [
    "/home/chien/Projects/pi-extensions/packages/pi-model-roles",
    "/home/chien/Projects/pi-extensions/packages/pi-scout",
    "/home/chien/Projects/pi-extensions/packages/pi-subagent"
  ]
}
```

- 不要同时使用 symlinks（`~/.pi/agent/extensions/` 目录）和 settings.json，会导致重复加载
- `package.json` 中 `"pi": { "extensions": ["./src/index.ts"] }` 告诉 pi 哪个文件是 extension 入口
- `"keywords": ["pi-package", "pi"]` — 所有 pi 插件必须包含这两个 keywords，`pi-package` 是 npm 发布标识，`pi` 用于 npm 搜索发现

**依赖库插件的加载顺序**：纯依赖库插件（不注册工具/命令）也必须注册 `session_start` 等 hook 来初始化状态。pi 按扩展列表顺序加载，但 `session_start` 是所有扩展加载完后统一触发的，所以**依赖库不需要排在消费者前面**。

### 插件间数据通信：import 走类型，globalThis 走状态

当插件 A（纯依赖库）需要被插件 B 消费时：

- **import 走类型** — B 通过 `import { getModelRolesAPI } from "@d3ara1n/pi-model-roles"` 获得完整类型推导，IDE 补全、编译检查全部正常
- **globalThis 走状态** — A 的内部状态（单例实例）必须存 globalThis，不能用 module-level `let`

**原因**：pi 通过 `settings.json` 的 `extensions` 数组加载插件时使用绝对路径（如 `/home/chien/Projects/pi-extensions/packages/pi-model-roles/src/index.ts`），而消费者通过 workspace symlink import（`node_modules/@d3ara1n/pi-model-roles/src/index.ts`）。两者指向同一文件，但 Bun module cache 会认为是两个不同模块，导致 module-level 变量各有一份、互不相通。globalThis 是进程级单例，不受 module identity 影响。

```typescript
// 纯依赖库（pi-model-roles/src/api.ts）
const GLOBAL_KEY = "__piModelRoles";

export function initModelRolesAPI(...): ModelRolesAPI {
  const api = ...;
  (globalThis as any)[GLOBAL_KEY] = api;  // 状态挂 globalThis
  return api;
}

export function getModelRolesAPI(): ModelRolesAPI {
  const api = (globalThis as any)[GLOBAL_KEY];
  if (!api) throw new Error("not initialized");
  return api;  // 类型安全，消费者拿到的还是 ModelRolesAPI
}
```

```typescript
// 消费者（pi-scout/src/index.ts）— 零感知
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";  // 类型安全
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
const roles: ModelRolesAPI = getModelRolesAPI();  // 完整类型推导
```

### 命令与配置约定

**配置字段名**：去掉 `@d3ara1n/pi-` 前缀后**转 camelCase**：

```jsonc
{
  "modelRoles": { ... },   // @d3ara1n/pi-model-roles
  "scout": { ... },        // @d3ara1n/pi-scout
  "subagent": { ... }      // @d3ara1n/pi-subagent
}
```

**命令注册**：pi 支持冒号命令名——`pi.registerCommand("scout:skill-router", { ... })` 注册后用户用 `/scout:skill-router on` 调用。不要用一个命令手动解析 args。

### README 与依赖文档规范

**每个包 README 必须包含 `## Install` 和 `## Dependencies`。** 即使是纯依赖库扩展（不注册 tool/command，只注册 hook），也要有 Install 段告诉用户如何安装。

**Extension vs Library 判定：**
- **Extension** — `package.json` 中有 `"pi": { "extensions": [...] }`，注册了 hook/tool/command。**必须**出现在用户 `settings.json` 的 `extensions` 数组里
- **Library** — 无 `pi.extensions` 入口，仅导出类型/函数供其他插件 import（如 `pi-usage-block-core`）

**npm 依赖 ≠ pi 加载。** npm 的 `dependencies` 只保证包安装到 `node_modules/`，不会让 pi 加载其 extension 入口。如果扩展 A 依赖扩展 B（如 `pi-peek-user` 依赖 `pi-peek`），两者**都必须**在 `settings.json` 的 `extensions` 数组里。

**主 README 的依赖标注：** Extensions 表格用统一角标（`<sup>†</sup>` / `<sup>‡</sup>`）标记有依赖的行，表后一行解释所有角标含义。

**各包 README 的 Dependencies 格式：**

```markdown
## Dependencies

- [`@d3ara1n/pi-xxx`](../pi-xxx) — 用途描述
```

只列 pi 插件依赖，不列框架级依赖（`pi-ai`、`pi-coding-agent`、`pi-tui` 等随 pi 附带的包）。

### 改动后的测试与重载

修改 `packages/*/src/**` 下的扩展源码，或改动了 `~/.pi/agent/settings.json` 的 `extensions`，都需要**用户手动重载** pi 才能生效——pi 在启动时加载扩展，运行中不会热更新。

写完插件后**不要立刻测试**，要先提醒用户：
- 用 `/reload` 重新加载扩展，或重启 pi
- 等用户确认重载完成后再开始测试

这一点对**需要 LLM 配合测试**的功能尤其重要（注册了 tool/command、改了 prompt 等）——这类功能刚写完时还没生效，此时马上测试，拿到的结果毫无意义，还会误导后续判断。

agent 的边界：
- ✅ 改源码、跑 `npm run typecheck`（`tsc --noEmit`）验证类型——这些在项目内，可自行完成
- ✅ 改 `settings.json` 把扩展路径加进去（只读改这一个数组）
- ❌ 不要自行 `pi --reload`、kill/restart pi 进程——重载由用户手动执行

---

## 经验区

### `ctx.ui.custom` 交互面板：底部面板必须用 `overlay: false`

用 `ctx.ui.custom` 实现底部交互面板（授权确认、多问题问答等）时，**必须设置 `overlay: false`**。

**`overlay: true` 的问题**：面板通过 `ui.showOverlay()` 全屏叠加，聊天区被完全遮挡、不可滚动——用户无法边看 agent 的指示边操作面板。pi-ask-user 最早踩过这个坑，pi-access-denied 重构 `AuthPanel` 时又踩了一次。

**正确做法**：`overlay: false` 渲染在底部 `editorContainer` 槽位（与 `ctx.ui.select()` / `input()` 共用），聊天区在上方保持可见、可通过终端原生滚动回溯。键盘焦点自动交给面板，上下箭头导航不受影响。

参考：`pi-ask-user` 的 `AskUserPanel` 和已修复的 `pi-access-denied` 的 `AuthPanel`。
