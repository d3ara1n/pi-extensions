# Pi Extensions Monorepo

> 本仓库是 **pi**（coding agent harness，npm 包 `@earendil-works/pi-coding-agent`）的插件集合——所有 `@d3ara1n/pi-*` 插件都在此开发与发布。
>
> 调查某个 `pi-xxx` 插件时，判断流程：
>
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

### Agent 署名

AI 辅助的提交必须在 message 尾部附 `Co-Authored-By` trailer，记录操作 agent：

```
Co-Authored-By: <PI_MODEL 环境变量的值> <noreply@pi.dev>
```

- 模型名以 `PI_MODEL` 环境变量为准，提交前读取，不凭记忆手写
- 邮箱统一 `noreply@pi.dev`，不使用各 provider 域名

### 示例

```
feat(pi-context-include): 支持嵌套 @ 引用
fix(pi-context-include): 修复 ~ 路径展开在 Windows 上的问题
chore: 更新依赖
docs(pi-context-include): 补充 README
```

完整 message 示例（AI 辅助提交）：

```
fix(pi-subagent): 区分后台任务状态并明确等待与纠偏规则

Co-Authored-By: glm-5.3 <noreply@pi.dev>
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

**配置加载：project 替换 global，不做字段级 merge。** 读取顺序是全局 `~/.pi/agent/settings.json` + 项目 `.pi/settings.json`，**项目配置整块替换全局**（`projectRaw ?? globalRaw`），缺失字段由 `DEFAULT_CONFIG` 经 per-field `??` 兑底。这与 pi 自身及 `pi-access-denied`（测试已锁定该语义）一致。

不要为加载逻辑写递归 `merge()`：绝大多数配置是扁平结构，整块替换语义清晰、无意外。仅当确有**跨文件部分覆盖某个 map**的需求时才作为例外保留深合并——当前只有 `pi-model-roles`（项目可只覆盖单个 role 的部分字段，如只改 `model` 保留 global 的 `provider`）。

**命令注册**：pi 支持冒号命令名——`pi.registerCommand("scout:skill-router", { ... })` 注册后用户用 `/scout:skill-router on` 调用。不要用一个命令手动解析 args。

### Prompt 文案分层（description / promptSnippet / promptGuidelines）

四层教学内容都进每次 LLM 请求（工具/参数 description 进 tools schema，promptSnippet/promptGuidelines 进 system prompt），同一事实教两遍 = 双倍 token 还互相稀释。每个事实只在一层出现，写文案前先判归属：

| 层 | 教什么 | 例 |
|----|--------|-----|
| tool description | 契约：工具做什么、返回什么 | "wait 只返回状态，从不返回结果" |
| param description | 契约：参数怎么填、参数间关系 | task/context/files 渠道分层 |
| promptSnippet | 一行入口，进 Available tools 列表 | |
| promptGuidelines | 政策：何时用、跨工具编排、行为禁令 | "别委派小事"、Typical flow、read-once collection |

功能改动时把教学加进当时最顺手的层，是 guidelines 逐句膨胀的根因；新增文案时先查另外三层是否已有。

### Prompt 文案不得跨插件引用

description / promptSnippet / promptGuidelines / 参数描述里不得提及**其他插件的工具、命令名**，除非它是本包声明的 extension 硬依赖（如 pi-mesh 之于其消费者，必然在场）。“only / the only way” 类绝对化声明同理禁止——它只在当前插件集合内成立，用户可以装第三方插件提供同类能力，不是 pi 的事实。

**原因：组合性。** 用户可能只装其中一个、或装竞品替代——没装时是幽灵引用，装了竞品时是误导。两个工具的边界引导靠各自把自身语义写准（如 read-only、对方无感知 vs 进入对方对话流、可行动），语义差自然涌现，不需要互相指名。

### README 与依赖文档规范

**每个包 README 必须包含 `## Installation` 和 `## Dependencies`。** 即使是只给其他插件消费的基础设施扩展（不注册 tool/command，只注册 hook），也要有 Install 段告诉用户如何加载。

**Extension vs Library 判定：**

- **Extension** — 包含必须由 pi 加载的资源，例如 `pi.extensions`、skills、prompts 或 themes。即使扩展只注册 hook、不直接提供用户命令或工具，也属于 extension，必须由用户显式安装和加载
- **Library** — 不包含任何 pi 可加载资源，只导出类型、函数或共享状态供其他包 import（如 `pi-usage-block-core`）。它作为普通 npm 依赖自动安装，不需要加入 pi 配置

**npm 依赖 ≠ pi 加载。** npm 的 `dependencies` 会在安装主包时安装到 `node_modules/`，但不会让 pi 加载依赖包声明的 extension/skill/prompt/theme 资源。如果扩展 A 依赖扩展 B（如 `pi-peek-user` 依赖 `pi-peek`），两者**都必须**在 `settings.json` 的 `extensions` 数组里；如果 A 只依赖纯 npm 库 C，则 C 只需在 `dependencies` 和 README 的 Dependencies 中声明。

**主 README 的依赖标注：** Extensions 表格用统一角标（`<sup>†</sup>` / `<sup>‡</sup>`）标记需要用户额外显式安装 extension 依赖的行，表后一行解释所有角标含义。纯 npm 库依赖不需要角标。

**各包 README 的 Dependencies 格式：**

```markdown
## Dependencies

- [`@d3ara1n/pi-xxx`](../pi-xxx) — 用途描述
```

列出本仓库中的直接 `@d3ara1n/pi-*` 依赖，包括必须显式加载的 extension 依赖、由 npm 自动安装的纯库依赖、以及可选集成依赖（需明确标记 optional）。不列框架级 peer dependencies（`pi-ai`、`pi-coding-agent`、`pi-tui`、`typebox` 等随 pi 附带的包）。

**Installation 章节格式固定：**

```markdown
## Installation

```bash
pi install npm:@d3ara1n/pi-xxx
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-xxx"
  ]
}
```
```

- **Extension 依赖**：消费者 README 的 Installation 必须按依赖优先顺序递归列出所有需要 pi 加载的 extension 的 `pi install` 命令；本地路径示例也必须列出这些 extension
- **纯 npm 库依赖**：只在 Dependencies 中声明，不在消费者的 Installation 中增加独立 `pi install`；安装主包时 npm 会自动安装它，也不要把它加入 `settings.json` 的 `extensions`
- **纯库自身 README**：Installation 使用 `npm install`，并明确说明它不是 standalone pi extension
- **可选 extension 依赖**：不放进主安装命令，单独说明如何安装和启用

**Model Compatibility 章节（可选）：** 插件实测出模型相关行为差异时，写入 `## Model Compatibility` 章节——每个模型家族一个 `###` 子节（如 `### GPT family`），章节引言注明观察对象是主模型。位置靠前（简介/设计理念之后），属于安装前选型信息。**没有真实观察就整节约去，不写占位文案。**

### 语言规范：面向社区的内容必须英文

本仓库是全英文开源项目。**面向社区/国际读者的产物必须英文**；仅本地/内部的产物可中文。

**必须英文**：
- 包 `README.md`（npm/GitHub 面向国际用户）
- 源码注释（JSDoc、行内注释——开源协作、IDE 提示、未来贡献者）
- 面向模型/用户的字符串：`description`、`promptSnippet`、`promptGuidelines`、错误信息、`package.json` 的 `description`、测试名（`test("...")` 描述）

**可中文**（本地/内部产物）：
- commit message（仓库历史惯例为中文）
- `plans/` 设计文档（内部设计记录）
- `AGENTS.md` 及 agent 指令、与用户的对话

判断标准：**它会出现在 npm/GitHub 被国际读者看到，或被读进模型 system prompt → 必须英文。**


### Provider 开发

写新的 pi provider（`pi-provider-xxx`）时，遵循 PROVIDER.md 的验证方法论——不盲写配置，每个 compat 维度必须实测确认。

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

### 测 pi-access-denied 时别用 `/tmp` 当测试根

pi-access-denied 的 PathManager 把 `/tmp`、`os.tmpdir()`、`/dev/null` 等作为 **builtin allow root**（任务级临时空间，OS 自动回收，不产生持久足迹，故默认放行）。这些 builtin 规则和 config 的 `allowedPaths`/`deniedPaths` 是**平等的规则**，一起进最长前缀匹配。

**坑**：用 `/tmp/ad-test/...` 当测试根去验证一条 config **allow** 规则时，builtin `/tmp` 会先命中并放行——你以为是你配的 allow rule 起作用了，其实是 builtin 短路了。此时 `deny` 规则仍然能穿透（deny 优先级高于 builtin allow），但 allow 的测试完全无效。

**正确做法**：测试 config 规则时用 home 下的非 builtin 路径（如 `~/ad-test/...`），这样 allow 放行才真正来自你配的规则。要确认 builtin safe roots 的完整列表，看 `paths.ts` 的 `builtinSafeRoots()`，或跑 `/access-denied status` 的 Allow rules 区块。

### bash gate 是 per-call 的：一条命令多个越界路径，命中第一个 block 就中断整条

pi-access-denied 拦截的是整个 `tool_call`。一条 bash 命令里若 token 扫描出多个越界路径，gate **一旦判定其中任一需 block，整个 `bash` 调用直接返回 block**，命令字符串里的其余部分根本不会执行。

**对测试的影响**：想逐个验证多条路径的判定结果（哪条 allow、哪条 deny），**不能**把它们塞进一条 `bash`（如 `cat a; cat b; cat c`）——只有第一个 block 之前的命令会跑，后面的全被吞。必须拆成多次独立的 `bash` 调用，每次一个路径，才能拿到各自的判定。

**设计原因**：gate 不知道命令内部各操作是否有依赖（`A && B` 中 B 可能依赖 A 的副作用），保守起见整个 call 级别拦截最安全。这也意味着真实场景下，agent 一条复合命令里只要有一个越界路径，整条都跑不了——这也是鼓励 agent 拆分操作、显式暴露每个路径的副作用。

### TypeScript 类型检查与测试命令（pi-extensions 项目结构）

本项目的工具链结构决定了正确命令；本机工具链事实（node 版本、bun 未装、先探测别全盘 find）见全局 `~/.agents/node-development.md`。

**项目结构：**

- monorepo，`tsconfig.json` 只在**仓库根**，子包无独立 tsconfig（`include: ["packages/*/src/**/*.ts"]`）
- 测试用 `node:test` + `node:assert`（Node 内置），无 bun/tsx/vitest

**正确命令：**

| 用途 | 命令 | 说明 |
|------|------|------|
| 类型检查（整个 monorepo） | `npx tsc --noEmit` | 仓库根或任意子目录均可（tsc 向上找根 tsconfig） |
| 跑单个测试 | `node --test packages/xxx/src/*.test.ts` | Node 原生跑 `.ts`，零依赖 |

**反模式：**

- ❌ 子包目录 `npm run typecheck` —— 子包 `package.json` 无此 script，npm workspace 报 `Missing script`（这正是常见的“目录错误”）
- ❌ `cd 子包 && tsc src/index.ts --noEmit` —— 绕过 tsconfig，丢类型解析和路径映射

**原理：** monorepo 共享根 tsconfig，类型检查是 monorepo 级别、一次覆盖所有包。

### 测试分层原则

- 默认测试必须离线、确定、可重复；外部进程、网络、模型 API、用户目录、自动安装和持久状态一律通过依赖注入与 fake 隔离。
- 真实边界验证写为显式 integration test，默认脚本不包含；integration test 只能使用临时沙箱，负责清理，缺少依赖时应干净跳过。
- 测试改动过的全局变量、环境变量、计时器和 mock 必须在结束时恢复，不能污染其他测试或用户环境。

### 不要给 JSON 配置文件剥注释

场景：读 pi 的 `settings.json`、npm 的 `package.json` 等**标准 JSON** 文件时，agent 常写正则剥离注释（`content.replace(/\/\/.*$/gm, "")`）想"兼容 JSONC"。这是**无用且破坏性**的。

**为什么剥离是错的：**

- 标准文件禁止注释——有注释就是语法错误，`JSON.parse` 会抛，这才是正确信号，不需要预处理
- 正则剥离会把**字符串字面量里的 `//`** 当注释删（如 URL `"https://example.com"` 被截成 `"https:`），留下未闭合字符串 → `JSON.parse` 抛错 → `catch` 静默吞掉 → 配置失效且**完全无感**
- 正则剥永远不安全（处理不了字符串内、转义、嵌套等）；真要 JSONC 必须用专门库（`jsonc-parser` / `strip-json-comments`）

**正确做法：**

- 读标准 JSON → **直接 `JSON.parse`**，出错让错误抛（`catch` 里降级返回默认即可），**不要预处理**
- 只有**明确声明支持注释的格式**才需要 JSONC 解析：`tsconfig.json`、`.vscode/*.json`、显式 `.jsonc`——这些有规范支持，且必须用专门库而非正则

**触发案例**：pi-context-include 早期读 `settings.json` 时写了注释剥离，会静默删掉用户配置里的 URL 值导致配置失效。已移除——直接 `JSON.parse`，非法文件自然报错。

### 仅测试导出的内部函数必须标记 `@internal`

当某个函数只在测试中使用（或除了生产代码外还被测试读取），但**不应该暴露给消费者**作为公共 API 时，必须在 JSDoc 中标注 `@internal`。否则它会出现在 IDE 自动补全中，污染消费者的类型推导。

```typescript
/**
 * @internal — exported for testing; use {@link underRoot} in production.
 */
export function posixUnder(posixTarget: string, posixRoot: string): boolean {
```

**判断标准**：

- 如果函数是纯工具函数、生产代码不直接用（或只作为内部实现细节），但需要单独测 → `@internal`
- 如果函数本身就是公共 API、多个生产模块都会 import → 不需要 `@internal`

**本仓库案例**：

- `pi-access-denied` 的 `posixUnder` — `underRoot` 的内部实现，仅测试单独验证 → `@internal`
- `pi-context-include` 的 `extractReferences` — 生产代码也调用，但消费者不应直接使用 → `@internal`

### 跨 workspace 包依赖必须用 `"*"`，不能用 `workspace:*` 或 `^x.y.z`

npm **从未实现** `workspace:` 协议（npm/cli#8845，文档写了但解析器不支持），`^x.y.z` 会触发 registry lookup 导致每次 `npm install` 后 lockfile 版号抖动。

**正确做法**：本仓库的跨包依赖统一写 `"*"`，npm workspaces 按包名本地 resolve，不查 registry。

```jsonc
// ✅ 正确
{ "dependencies": { "@d3ara1n/pi-model-roles": "*" } }

// ❌ 错误 — npm 直接报 EUNSUPPORTEDPROTOCOL
{ "dependencies": { "@d3ara1n/pi-model-roles": "workspace:*" } }

// ❌ 错误 — lockfile 抖动
{ "dependencies": { "@d3ara1n/pi-model-roles": "^0.1.0" } }
```

**新建包时必须遵循此规则**，否则回归 lockfile 抖动问题。

### 交互 UI 按 `ctx.mode` 分轨道设计，不要用 `ctx.hasUI`

pi 有四种会话模式（`tui | rpc | print | json`）。注册交互 UI 的插件必须**双轨设计**：TUI 用 `ctx.ui.custom()` 面板（完整功能），其余模式降级到 `ctx.ui.select()/confirm()` 对话框——判断用 `ctx.mode`，不要用 `ctx.hasUI`。

**为什么 hasUI 会说谎**：RPC 模式绑了一个 stub uiContext（`select/confirm/input/editor` 走 `extension_ui_request` 子协议等宿主应答，是可用的；`custom()` 却静默返回 `undefined`——TUI 组件工厂无法跨 JSONL 边界），所以 `hasUI` 在 rpc 下是 **true**。pi-subagent 的子进程正跑在 rpc 模式：ask_user 曾因此漏过 hasUI 守卫，在 `result.answers` 上抛裸 TypeError。

**降级轨道的能力边界按协议交集承诺**：`select/confirm` 是 pi 扩展子协议与 ACP（`session/request_permission` 的 option name/optionId 为自由字符串）共同原生保证的部分，任意多选一问题都能无损承载；`input/editor` 在 ACP 无文本输入原语（协议缺口，非适配器缺陷），只能做自适应探测（如先验证一次 input 成功再开放依赖它的功能），不可无条件轮询。降级后的 JSON 契约必须与 TUI 轨道完全一致，让 LLM 不感知模式差异。print/json 无宿主应答，dialog 解析为取消即体面语义。

参考实现：pi-access-denied 的 `dialogDecision`、pi-ask-user 的 `dialogAsk`（均为 `tui ? 原 custom() 调用 : dialog 降级` 三元双轨）。

### 新插件开发默认面向多模式（RPC/ACP）

写插件时默认考虑非 TUI 宿主（ACP 编辑器、`--mode rpc`、print/json），按以下能力分层自查：

- **工具结果一律返回纯文本 `content`** —— 四种会话模式共通的载体，天然免改造。`renderCall/renderResult` 等 pi-tui 渲染器仅在 TUI 加载，RPC 下自动缺席且无害；`execute()` 内不得依赖渲染器的存在。
- **fire-and-forget 类 UI 在 RPC 原生可用**：`setStatus`、`setWidget(string[])`、`notify` 经 `extension_ui_request` 子协议转发。组件工厂类（`custom/setFooter/setEditorComponent/getEditorText`）是 TUI-only，RPC 下 no-op 或返回空值——用它们的功能要么双轨降级（见上条），要么接受静默缺席。
- **extension commands 当前在主流 ACP 适配器中不可达**：依赖命令入口的交互功能要么加 `ctx.mode` 守卫并给出可执行提示，要么同时注册工具等价物。
- **改完跑一遍模式自查**：这个插件在 Zed + pi-acp 里会怎样？工具能调、进度能看、交互有降级或明确不可达——三者之一即可，不允许「调用即崩」。
