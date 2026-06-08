# Pi Extensions Monorepo

## Commit 规范

所有 commit 必须使用 Conventional Commits 格式：

```
<type>(<scope>): <description>
```

- **type**: `feat` | `fix` | `chore` | `docs` | `refactor` | `style` | `test`
- **scope**: 包目录名，如 `pi-context-include`
 破坏性变更加 `!` 后缀：`feat(pi-context-include)!: 改了配置格式`

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

## Pi Extension 开发笔记

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

### 插件安装方式

在 `~/.pi/agent/settings.json` 的 `extensions` 数组中添加绝对路径：

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

### 依赖库插件的加载顺序

纯依赖库插件（不注册工具/命令）也必须注册 `session_start` 等 hook 来初始化状态。pi 按扩展列表顺序加载，但 `session_start` 是所有扩展加载完后统一触发的，所以**依赖库不需要排在消费者前面**。

### settings.json 中的插件配置结构

插件配置字段名约定：去掉 `@d3ara1n/pi-` 前缀后**转 camelCase**：

```jsonc
{
  "modelRoles": { ... },   // @d3ara1n/pi-model-roles
  "scout": { ... },        // @d3ara1n/pi-scout
  "subagent": { ... }      // @d3ara1n/pi-subagent
}
```

### 命令注册语法

pi 支持冒号命令名：`pi.registerCommand("scout:skill-router", { ... })` 注册后用户用 `/scout:skill-router on` 调用。不要用一个命令手动解析 args。
