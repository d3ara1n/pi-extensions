# Model Roles + Scout + Subagent 编排系统 v2

> **状态：可实施** — 所有关键 API 已验证可用：
> - `complete()` from `@earendil-works/pi-ai` 可在 extension 进程内发起 LLM 推理
> - `pi.setModel()` + `pi.setThinkingLevel()` 可在 `before_agent_start` 中切换模型
> - `event.systemPromptOptions.skills` 提供结构化的 skill 列表，无需自行扫描
> - `ctx.modelRegistry.getApiKeyAndHeaders()` 可解析 API 密钥
>
> 参考：`pi-mcp-adapter/sampling-handler.ts`、`examples/extensions/preset.ts`、`examples/extensions/subagent/index.ts`。

---

## 1. 调研结论

### 1.1 Side Agent 可以直接在 pi 进程内调 LLM

pi extension 运行在 pi 主进程中，此时 `@earendil-works/pi-ai` 的 provider 已全部注册完毕。
调用方式：

```typescript
import { complete } from "@earendil-works/pi-ai";
import type { Api, Model, Message, Context } from "@earendil-works/pi-ai";

// 从 modelRegistry 获取模型实例和 API Key
const models = ctx.modelRegistry.getAvailable();
const sideModel = models.find(m => `${m.provider}/${m.id}` === "google/gemini-2.5-flash");

const auth = await ctx.modelRegistry.getApiKeyAndHeaders(sideModel);

const result = await complete(sideModel, {
  systemPrompt: "You are a skill router...",
  messages: [{ role: "user", content: userPrompt }],
}, {
  apiKey: auth.apiKey,
  headers: auth.headers,
  maxTokens: 1024,
});
```

### 1.2 Subagent 用 spawn pi 子进程（同 pi-subagents）

pi-subagents 的做法：`spawn("pi", ["--mode", "json", "--model", ..., "-p", "Task: ..."])`。
我们的 subagent 编排也用这个模式，但角色定义和模型路由由 pi-model-roles 提供。

### 1.3 pi Extension 可用的事件钩子

| 事件 | 触发时机 | 可修改内容 |
|------|---------|-----------|
| `session_start` | 会话开始 | 初始化状态 |
| `before_agent_start` | **每轮 LLM 调用前** | `return { systemPrompt }` 可修改 system prompt；handler 内可直接调用 `pi.setModel()`、`pi.setThinkingLevel()` 切换模型 |
| `message_end` | LLM 响应完成 | 读取响应内容 |
| `model_select` | 模型切换后 | 读取新模型信息 |
| `session_shutdown` | 会话结束 | 清理状态 |
| `tool_call` | 工具调用前 | 可拦截/修改工具调用参数 |

### 1.4 关键 API 能力

```typescript
// ExtensionAPI 方法
pi.setModel(model)            // 切换当前模型（返回 false 表示无 API key）
pi.setThinkingLevel(level)    // 设置 thinking level
pi.registerTool(tool)         // 注册工具
pi.getActiveTools()           // 获取当前活跃工具列表
pi.setActiveTools([...names]) // 修改活跃工具列表（可动态加减工具）
pi.on(event, handler)         // 注册事件钩子
pi.registerCommand(...)       // 注册斜杠命令
pi.registerMessageRenderer(...) // 注册消息渲染器

// ExtensionContext（每次事件回调中获取）
ctx.modelRegistry.getAvailable()                    // Model<Api>[] 所有可用模型
ctx.modelRegistry.getApiKeyAndHeaders(model)         // { ok, apiKey, headers } API 密钥
ctx.model?.provider                                  // 当前模型 provider
ctx.cwd                                              // 当前工作目录
ctx.hasUI                                            // 是否有 UI
ctx.ui.notify(msg, type)                             // 发送通知
ctx.ui.setStatus(key, value)                         // 设置状态栏
ctx.sessionManager.getSessionFile()                   // 当前会话文件路径
ctx.sessionManager.getSessionId()                     // 当前会话 ID
ctx.settings                                         // pi 配置
```

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        pi 主进程                                     │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  pi-model-roles（纯依赖库扩展）                                │   │
│  │                                                             │   │
│  │  • 角色定义只读 (settings.json modelRoles 字段)               │   │
│  │  • 角色解析 → Model<Api> + apiKey + headers                  │   │
│  │  • 全局状态注册表 (globalThis.__piModelRoles)                  │   │
│  │  • 不注册任何工具、命令、事件钩子                                │   │
│  └──────────────────────┬──────────────────────────────────────┘   │
│                         │ globalThis                                 │
│  ┌──────────────────────┼──────────────────────────────────────┐   │
│  │                      │                                        │   │
│  │  ┌───────────────────▼──────────────────────────────────┐   │   │
│  │  │  pi-scout（每轮 side agent 决策框架）                    │   │   │
│  │  │                                                      │   │   │
│  │  │  before_agent_start hook:                             │   │   │
│  │  │    1. 拦截 <available_skills> XML 块                    │   │   │
│  │  │    2. 调 side agent 分析 prompt                         │   │   │
│  │  │    3. 内置模块 skill-router → 注入选中 skill 内容        │   │   │
│  │  │    4. 内置模块 model-router → 切换模型角色               │   │   │
│  │  │                                                      │   │   │
│  │  │  两个内置模块可独立开关:                                  │   │   │
│  │  │    /scout:skill-router on/off                          │   │   │
│  │  │    /scout:model-router on/off                          │   │   │
│  │  └──────────────────────────────────────────────────────┘   │   │
│  │                                                             │   │
│  │  ┌──────────────────────────────────────────────────────┐   │   │
│  │  │  pi-subagent（角色化 subagent）                         │   │   │
│  │  │                                                      │   │   │
│  │  │  delegate 工具:                                        │   │   │
│  │  │    1. 按 role 从 pi-model-roles 分配模型               │   │   │
│  │  │    2. spawn pi 子进程执行任务                           │   │   │
│  │  │    3. 收集结果返回主模型                                │   │   │
│  │  └──────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 插件 1：pi-model-roles

### 3.1 定位

纯依赖库。不注册任何工具、命令、事件钩子。
只提供角色配置的**只读** API，以及将角色名解析为 `Model<Api>` 实例的能力。
用户通过手动编辑 `settings.json` 管理角色配置。
其他扩展通过 `globalThis.__piModelRoles` 访问。

### 3.2 配置文件

路径：`~/.pi/agent/settings.json` 中的 `modelRoles` 字段（跟随 pi 标准配置体系）。

```jsonc
{
  "modelRoles": {
    "roles": {
      "heavy": {
        "model": "anthropic/claude-opus-4",
        "thinking": "high",
        "description": "架构设计、深度调试、复杂迁移",
        "tools": "read,bash,edit,write,glob,grep"  // 可选：该角色默认工具集
      },
      "default": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "medium",
        "description": "日常编码，速度和质量平衡"
      },
      "fast": {
        "model": "google/gemini-2.5-flash",
        "thinking": "off",
        "description": "快速修改、简单问答"
      },
      "side": {
        "model": "google/gemini-2.5-flash-lite",
        "thinking": "off",
        "description": "内部辅助：scout 的 side agent 模型（不暴露给用户）",
        "hidden": true  // 不在 /roles 命令中显示
      }
    },
    // 可选：角色解析失败时的 fallback
    "defaultRole": "default"
  }
}
```

### 3.3 核心 API

```typescript
// packages/pi-model-roles/src/api.ts

export interface RoleConfig {
  /** 模型标识，格式: "provider/model-id"，如 "anthropic/claude-sonnet-4" */
  model: string;
  /** Thinking level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" */
  thinking?: string;
  /** 角色描述 */
  description?: string;
  /** 该角色默认可用的工具列表，逗号分隔 */
  tools?: string;
  /** 是否在 /roles 列表中隐藏 */
  hidden?: boolean;
  /** 该角色的 system prompt 追加内容（可选） */
  systemPromptAppend?: string;
}

export interface ModelRolesConfig {
  roles: Record<string, RoleConfig>;
  defaultRole?: string;
}

export interface ResolvedRole {
  name: string;
  config: RoleConfig;
  /** 解析后的 Model<Api> 实例，未找到则为 undefined */
  model: Model<Api> | undefined;
  /** 该模型的 API Key */
  apiKey: string | undefined;
  /** 该模型的自定义 headers */
  headers: Record<string, string> | undefined;
}

export interface ModelRolesAPI {
  /** 读取所有角色配置 */
  getRoles(): Record<string, RoleConfig>;

  /** 获取单个角色配置 */
  getRole(name: string): RoleConfig | undefined;

  /**
   * 解析角色名为可用的模型实例（同步，不含认证信息）。
   * 如果角色对应的模型不可用（未配置/未安装），返回 model=undefined。
   */
  resolveRole(name: string): ResolvedRole;

  /** 异步解析角色名，获取完整的模型实例和认证信息 */
  resolveRoleAsync(name: string): Promise<ResolvedRole>;

  /** 获取默认角色名 */
  getDefaultRole(): string;

  /** 获取所有非隐藏角色（用于展示给用户） */
  getVisibleRoles(): Record<string, RoleConfig>;

  /**
   * 给定一个模型标识（如 "anthropic/claude-sonnet-4"），
   * 查找使用该模型的第一个角色名。
   * 用于反向查找"当前模型对应什么角色"。
   */
  findRoleByModel(modelId: string): string | undefined;
}
```

### 3.4 全局注册机制

```typescript
// packages/pi-model-roles/src/index.ts

import type { ModelRolesAPI } from "./api.ts";

const GLOBAL_KEY = "__piModelRoles";

export default function registerModelRolesExtension(pi: ExtensionAPI): void {
  const api = createModelRolesAPI(pi);
  (globalThis as any)[GLOBAL_KEY] = api;
}

export function getModelRolesAPI(): ModelRolesAPI | undefined {
  return (globalThis as any)[GLOBAL_KEY];
}
```

### 3.5 目录结构

```
packages/pi-model-roles/
  package.json
  src/
    index.ts          # extension 入口（注册 globalThis）
    api.ts            # ModelRolesAPI 接口定义
    config.ts         # 角色配置读取（从 pi settings 中读取 modelRoles 字段）
    resolver.ts       # 角色名 → Model<Api> 解析逻辑
    types.ts          # 共享类型导出（RoleConfig, ResolvedRole 等）
  README.md
```

### 3.6 package.json

```json
{
  "name": "@d3ara1n/pi-model-roles",
  "version": "0.1.0",
  "description": "Model role configuration library for pi extensions — defines named model roles and resolves them to Model instances",
  "main": "src/index.ts",
  "types": "src/types.ts",
  "keywords": ["pi-package", "pi"],
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-ai": { "optional": true },
    "@earendil-works/pi-coding-agent": { "optional": true }
  },
  "dependencies": {},
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "license": "MIT"
}
```

注意：`pi.extensions` 中注册是为了让 pi 加载它（从而执行 globalThis 注册），
但它不注册工具、不注册命令、不注册事件钩子。

### 3.7 关键实现细节

#### config.ts — 配置读取

```typescript
// 从 pi 的 settings 中读取 modelRoles 配置（只读）
// settings 路径：
//   - 用户级: ~/.pi/agent/settings.json → settings.modelRoles
//   - 项目级: .pi/settings.json → settings.modelRoles
// 合并策略：项目级覆盖用户级
// 修改角色配置只能由用户手动编辑 settings.json

export function loadRolesConfig(settings: any): ModelRolesConfig {
  const config = settings?.modelRoles;
  if (!config || !config.roles) {
    return { roles: {}, defaultRole: "default" };
  }
  return config as ModelRolesConfig;
}
```

#### resolver.ts — 角色解析

```typescript
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export function resolveModelForRole(
  roleConfig: RoleConfig,
  modelRegistry: ModelRegistry,
): { model: Model<Api> } | undefined {
  const parts = roleConfig.model.split("/");
  const provider = parts.length > 1 ? parts[0] : undefined;
  const modelId = parts.length > 1 ? parts[1] : parts[0];

  const available = modelRegistry.getAvailable();
  const match = available.find(m => {
    if (provider) return m.provider === provider && m.id === modelId;
    return m.id === modelId;
  });

  if (!match) return undefined;
  return { model: match };
}

export async function resolveModelForRoleAsync(
  roleConfig: RoleConfig,
  modelRegistry: ModelRegistry,
): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string> } | undefined> {
  const available = modelRegistry.getAvailable();
  const parts = roleConfig.model.split("/");
  const provider = parts.length > 1 ? parts[0] : undefined;
  const modelId = parts.length > 1 ? parts[1] : parts[0];

  const match = available.find(m => {
    if (provider) return m.provider === provider && m.id === modelId;
    return m.id === modelId;
  });

  if (!match) return undefined;

  const auth = await modelRegistry.getApiKeyAndHeaders(match);
  if (auth.ok === false) return undefined;

  return { model: match, apiKey: auth.apiKey, headers: auth.headers };
}
```

---

## 4. 插件 2：pi-scout

### 4.1 定位

每轮 side agent 决策框架。依赖 pi-model-roles 提供角色配置。

核心能力：在每轮对话开始前，用最便宜的 side agent 模型分析用户 prompt，
执行用户启用的决策模块。内置两个模块，可独立开关：

1. **skill-router**：拦截 pi 注入的 skill 元数据，改为只注入选中 skill 的完整内容
2. **model-router**：根据 prompt 内容自动切换模型角色

### 4.2 核心流程

```
用户发送 prompt
    │
    ▼
before_agent_start hook 触发
    │
    ├─ 1. 从 event.systemPromptOptions.skills 获取所有已加载 skill 的 name + description + location
    │
    ├─ 2. 拦截：用正则从 event.systemPrompt 中移除整个 <available_skills>...</available_skills> 块
    │
    ├─ 3. 构建 side agent 请求：
    │     system prompt = SCOUT_SYSTEM_PROMPT（JSON schema 约束）
    │     messages = [{ role: "user", content: "用户 prompt:\n{event.prompt}\n\n可用 skills:\n{skill 列表}\n\n当前角色: {currentRole}" }]
    │
    ├─ 4. 调用 complete(sideModel, context, options)
    │     使用 pi-model-roles 的 side 角色模型
    │     maxTokens: 256
    │
    ├─ 5. 解析 side agent 返回的 JSON：
    │     { "skills": ["skill-1", "skill-2"], "role": "heavy|null", "reasoning": "..." }
    │
    ├─ 6. [如果 skill-router 启用] 注入选中 skill 的完整内容：
    │     a. 从 systemPromptOptions.skills 获取选中 skill 的 location 路径
    │     b. 读取 SKILL.md 文件内容
    │     c. 将完整内容追加到 system prompt 末尾
    │
    ├─ 7. [如果 model-router 启用] 切换模型角色：
    │     调用 pi.setModel() + pi.setThinkingLevel()
    │
    └─ 返回 { systemPrompt: cleanedPrompt + injectedSkillContent }
```

### 4.3 Side Agent 的 System Prompt

```
You are a scout. Analyze the user's request and decide which skills and model role to use.

## Response Format
Respond with ONLY a JSON object, no markdown, no explanation outside the JSON:
{
  "skills": ["skill-name-1", "skill-name-2"],
  "role": "role-name-or-null",
  "reasoning": "one sentence explanation"
}

## Rules
- Select at most 5 skills. Select 0 if none are relevant.
- Only select skills that will materially help with the task.
- If the task is trivial (simple question, acknowledgment), select 0 skills.
- "role" should be null if the current role is appropriate.
- Only suggest a role change when the task clearly benefits from a different model.
- Be conservative: prefer fewer skills and no role change when uncertain.
```

### 4.4 Skill 拦截与注入（skill-router 模块）

pi 默认将所有 skill 的元数据（name + description + location）作为 `<available_skills>` XML 块注入 system prompt。
**scout 拦截并完全移除这个 XML 块**，改为只注入选中 skill 的 SKILL.md 原文。
主模型永远看不到 skill 元数据列表。

```typescript
import * as fs from "node:fs";

// 拦截：移除 pi 注入的 skill 元数据 XML 块
const SKILLS_XML_RE = /<available_skills>[\s\S]*?<\/available_skills>/g;

function stripSkillsBlock(systemPrompt: string): string {
  return systemPrompt.replace(SKILLS_XML_RE, "");
}

// 注入：读取选中 skill 的完整 SKILL.md 内容
function readSkillContent(
  selectedSkills: string[],
  allSkills: Array<{ name: string; location: string }>,
): string {
  const parts: string[] = [];
  for (const name of selectedSkills) {
    const skill = allSkills.find(s => s.name === name);
    if (!skill?.location) continue;
    try {
      const content = fs.readFileSync(skill.location, "utf8").trim();
      if (content) {
        parts.push(`--- Skill: ${name} ---\n${content}`);
      }
    } catch {
      // skill 文件不存在或不可读，跳过
    }
  }
  return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
}
```

### 4.5 模型切换（model-router 模块）

`pi.setModel(model)` 和 `pi.setThinkingLevel(level)` 是官方 ExtensionAPI，
可在 `before_agent_start` handler 内直接调用。

```typescript
// 在 before_agent_start handler 内
if (decision.role && decision.role !== currentRole) {
  const rolesApi = getModelRolesAPI();
  const resolved = await rolesApi.resolveRoleAsync(decision.role);
  if (resolved?.model) {
    await pi.setModel(resolved.model);
    if (resolved.config.thinking) {
      pi.setThinkingLevel(resolved.config.thinking);
    }
  }
}
```

### 4.6 性能考虑

- side agent 调用延迟约 0.5-2s（取决于模型和 prompt 长度）
- 每轮对话前都会触发
- 优化：side agent 输出 token 限制在 256

### 4.7 目录结构

```
packages/pi-scout/
  package.json
  src/
    index.ts              # extension 入口，注册命令、事件钩子
    side-agent.ts         # side agent 调用逻辑（complete()）
    scout-prompt.ts       # side agent 的 system prompt 模板
    skill-inject.ts       # 拦截 <available_skills> XML + 注入选中 skill 完整内容
    model-switch.ts       # 模型角色切换逻辑
    config.ts             # 设置读取
    types.ts              # 共享类型
  README.md
```

### 4.8 package.json

```json
{
  "name": "@d3ara1n/pi-scout",
  "version": "0.1.0",
  "description": "Per-turn side agent decision framework for pi — uses a cheap model to select skills and route models before each conversation turn",
  "main": "src/index.ts",
  "keywords": ["pi-package", "pi"],
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@d3ara1n/pi-model-roles": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-ai": { "optional": true },
    "@earendil-works/pi-coding-agent": { "optional": true },
    "@d3ara1n/pi-model-roles": { "optional": true }
  },
  "dependencies": {
    "@d3ara1n/pi-model-roles": "^0.1.0",
    "typebox": "^1.1.24"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "license": "MIT"
}
```

### 4.9 注册的命令

| 名称 | 说明 |
|------|------|
| `/scout` | 显示 scout 状态（side agent 模型、各模块开关状态） |
| `/scout:skill-router on/off` | 开关 skill-router 模块 |
| `/scout:model-router on/off` | 开关 model-router 模块 |
| `/scout status` | 显示上一次 side agent 的选择结果和 reasoning |

### 4.10 设置项

在 `~/.pi/agent/settings.json` 的 `scout` 字段：

```jsonc
{
  "scout": {
    "enabled": true,
    "sideAgentRole": "side",        // pi-model-roles 中的角色名
    "maxSelectedSkills": 5,          // 最多选几个 skill
    "modules": {
      "skillRouter": true,           // skill-router 模块开关
      "modelRouter": true            // model-router 模块开关
    }
  }
}
```

---

## 5. 插件 3：pi-subagent

### 5.1 定位

角色化 subagent 编排。依赖 pi-model-roles 提供角色配置。
提供 `delegate` 工具，让主模型按角色委派任务给 pi 子进程。

### 5.2 内置 Subagent 角色

```typescript
interface SubagentRole {
  role: string;          // pi-model-roles 中定义的角色名
  systemPrompt?: string; // 该角色的 system prompt（覆盖 agent 定义的）
  tools?: string[];      // 可用工具白名单
}

// 内置角色定义（可通过 settings 覆盖）
const BUILTIN_SUBAGENT_ROLES: Record<string, SubagentRole> = {
  explorer: {
    role: "fast",
    tools: ["read", "bash", "find", "grep", "glob"],
    systemPrompt: "You are a fast code explorer. Read files, search patterns, map dependencies. Do NOT edit any files. Report findings concisely.",
  },
  reviewer: {
    role: "heavy",
    tools: ["read", "bash", "grep", "glob"],
    systemPrompt: "You are a senior code reviewer. Inspect code for correctness, maintainability, security issues. Do NOT edit files. Provide evidence-backed findings with file/line references.",
  },
  worker: {
    role: "default",
    tools: ["read", "bash", "edit", "write", "grep", "glob"],
    systemPrompt: "You are an implementation worker. Follow the given plan precisely. Make minimal, focused changes. Report what you changed and what validation you ran.",
  },
  researcher: {
    role: "fast",
    tools: ["web_search", "fetch_content", "read"],
    systemPrompt: "You are a web researcher. Find relevant documentation, examples, and best practices. Return concise summaries with source links.",
  },
};
```

### 5.3 子进程 Spawn 逻辑

```typescript
import { spawn } from "node:child_process";
// 参考 pi 官方 examples/extensions/subagent/index.ts 的简化实现

interface SpawnOptions {
  role: string;           // subagent 角色（explorer/reviewer/worker/researcher）
  task: string;           // 任务描述
  cwd?: string;           // 工作目录
  sessionFile?: string;   // 可选的 session 文件（用于多轮子进程）
  maxTokens?: number;     // 最大输出 token
  timeoutMs?: number;     // 超时
}

async function spawnSubagent(
  options: SpawnOptions,
  modelRegistry: ModelRegistry,
): Promise<SubagentResult> {
  const rolesApi = getModelRolesAPI();
  const subagentRole = BUILTIN_SUBAGENT_ROLES[options.role];
  const resolvedRole = rolesApi.resolveRole(subagentRole.role);

  if (!resolvedRole.model) {
    throw new Error(`Model for subagent role "${options.role}" (${subagentRole.role}) is not available`);
  }

  // 构造 pi 命令行参数
  const args = [
    "--mode", "json",
    "--model", `${resolvedRole.model.provider}/${resolvedRole.model.id}`,
    "--no-session",
  ];

  if (subagentRole.tools) {
    args.push("--tools", subagentRole.tools.join(","));
  }

  if (subagentRole.systemPrompt) {
    const tmpFile = path.join(os.tmpdir(), `pi-subagent-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, subagentRole.systemPrompt);
    args.push("--system-prompt", tmpFile);
  }

  if (options.sessionFile) {
    args.push("--session", options.sessionFile);
  }

  const env = {
    ...process.env,
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_CHILD_AGENT: options.role,
  };

  args.push(`Task: ${options.task}`);

  // Spawn 子进程（Linux/Mac 直接 spawn "pi"）
  const proc = spawn("pi", args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 解析 JSON 事件流 → 等待完成 → 返回 SubagentResult
}
```

### 5.4 注册为 pi 工具

```typescript
pi.registerTool({
  name: "delegate",
  label: "Delegate to subagent",
  description: "Delegate a task to a specialized subagent. Available roles: explorer (fast code search), reviewer (deep code review), worker (implementation), researcher (web research).",
  parameters: Type.Object({
    role: Type.Union([
      Type.Literal("explorer"),
      Type.Literal("reviewer"),
      Type.Literal("worker"),
      Type.Literal("researcher"),
    ]),
    task: Type.String({ description: "Specific task for the subagent" }),
    cwd: Type.Optional(Type.String()),
    async: Type.Optional(Type.Boolean({ description: "Run in background (default: true)" })),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    return spawnSubagent({
      role: params.role,
      task: params.task,
      cwd: params.cwd ?? ctx.cwd,
    }, ctx.modelRegistry);
  },
  renderCall(args, theme) {
    return new Text(`${theme.bold("delegate")} ${theme.fg("accent", args.role)}`, 0, 0);
  },
  renderResult(result, options, theme) {
    // 渲染子进程输出
  },
});
```

### 5.5 目录结构

```
packages/pi-subagent/
  package.json
  src/
    index.ts              # extension 入口，注册 delegate 工具
    spawn.ts              # spawn pi 子进程的核心逻辑
    roles.ts              # 内置 subagent 角色定义
    result.ts             # 子进程结果解析
    config.ts             # 设置读取
  README.md
```

### 5.6 package.json

```json
{
  "name": "@d3ara1n/pi-subagent",
  "version": "0.1.0",
  "description": "Role-based subagent orchestration for pi — delegates tasks to specialized pi child processes with configurable model roles",
  "main": "src/index.ts",
  "keywords": ["pi-package", "pi"],
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@d3ara1n/pi-model-roles": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-ai": { "optional": true },
    "@earendil-works/pi-coding-agent": { "optional": true },
    "@d3ara1n/pi-model-roles": { "optional": true }
  },
  "dependencies": {
    "@d3ara1n/pi-model-roles": "^0.1.0",
    "typebox": "^1.1.24"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "license": "MIT"
}
```

### 5.7 设置项

在 `~/.pi/agent/settings.json` 的 `subagent` 字段：

```jsonc
{
  "subagent": {
    "timeoutMs": 300000   // subagent 超时 5 分钟
  }
}
```

---

## 6. 实施计划

### Phase 1：pi-model-roles（纯依赖库）

**目标**：可独立安装，其他扩展可通过 globalThis 访问角色配置。

1. 创建 `packages/pi-model-roles/` 目录结构
2. 实现 `config.ts` — 从 pi settings 读取角色配置
3. 实现 `resolver.ts` — 角色名 → Model<Api> 解析
4. 实现 `api.ts` — ModelRolesAPI 接口和实现
5. 实现 `index.ts` — extension 入口，注册 globalThis
6. 编写 README
7. 测试：安装到 pi，验证 `globalThis.__piModelRoles` 可访问

### Phase 2：pi-scout（核心框架 + 两个模块）

**目标**：scout 能在每轮对话前拦截 skill、决策模型和 skill 注入。

1. 创建 `packages/pi-scout/` 目录结构
2. 实现 `side-agent.ts` — 调用 complete() 的核心逻辑
3. 实现 `scout-prompt.ts` — side agent 的 system prompt
4. 实现 `skill-inject.ts` — 拦截 `<available_skills>` XML + 读取选中 SKILL.md 注入
5. 实现 `model-switch.ts` — pi.setModel() + pi.setThinkingLevel() 切换
6. 实现 `index.ts` — before_agent_start hook + 命令注册
7. 测试：验证 XML 拦截、skill 注入、模型切换、模块独立开关

### Phase 3：pi-subagent（角色化 subagent）

**目标**：主模型可以通过 `delegate` 工具委派任务给 subagent。

1. 创建 `packages/pi-subagent/` 目录结构
2. 实现 `roles.ts` — 内置 subagent 角色定义
3. 实现 spawn 辅助逻辑（参考官方 subagent 示例）
4. 实现 `spawn.ts` — spawn 子进程并解析 JSON 事件流
5. 注册 `delegate` 工具
6. 测试：从 pi 中调用 delegate 工具，验证子进程执行和结果返回

### Phase 4：打磨

1. 完善错误处理和边界情况
2. 验证三个插件协同工作
3. 编写 README

---

## 7. 风险和备选方案

### 7.1 Side Agent 延迟

每轮对话增加 0.5-2s 延迟。

**缓解**：
- side agent 输出 token 限制在 256
- 缓存 side agent 结果（同一 prompt 不重复调用）

### 7.2 pi-spawn 跨平台兼容

Linux/Mac 直接 `spawn("pi", args)` 即可。
Windows 需查找 pi 入口脚本（参考官方 subagent 示例的 `getPiInvocation()`）。

### 7.3 pi-ai Provider 注册时机

`@earendil-works/pi-ai` 的 providers 在 pi 主进程启动时注册。
extension 在之后加载，所以 providers 一定已经可用。

---

## 8. 依赖关系图

```
pi (核心运行时)
 ├── @earendil-works/pi-ai          (LLM 推理 API + providers)
 ├── @earendil-works/pi-coding-agent (extension API + types)
 │
 ├── pi-model-roles (extension)
 │    └── 读取 settings.modelRoles
 │    └── 注册 globalThis.__piModelRoles
 │    └── 无工具、无命令、无钩子
 │
 ├── pi-scout (extension)
 │    ├── 依赖 pi-model-roles (通过 globalThis)
 │    ├── 依赖 @earendil-works/pi-ai (complete 函数)
 │    ├── 注册 before_agent_start hook
 │    ├── 内置模块: skill-router（拦截 + 注入 skill 内容）
 │    ├── 内置模块: model-router（自动切换模型角色）
 │    └── 注册 /scout, /scout:skill-router, /scout:model-router 命令
 │
 └── pi-subagent (extension)
      ├── 依赖 pi-model-roles (通过 globalThis)
      ├── 注册 delegate 工具
      └── spawn pi 子进程按角色执行任务
```

---

## 9. 参考实现

| 资源 | 用途 |
|------|------|
| `pi-mcp-adapter/sampling-handler.ts` | in-process LLM 调用的完整示例（complete + modelRegistry） |
| `pi-subagents/src/runs/shared/pi-args.ts` | 构造 pi CLI 参数（--mode json, --model, --tools 等） |
| `examples/extensions/subagent/index.ts` | 官方 subagent 示例，spawn pi 子进程的简化实现 |
| `examples/extensions/pirate.ts` | before_agent_start 中修改 systemPrompt 的示例 |
| `examples/extensions/preset.ts` | setModel + setThinkingLevel + setActiveTools 的完整示例 |
| `pi-rtk-optimizer/src/index.ts` | before_agent_start 中修改 systemPrompt 的生产级实现 |
| `pi-coding-agent/docs/extensions.md` | Extension API 官方文档 |
| `@earendil-works/pi-ai` | complete/stream/streamSimple/completeSimple API + 类型定义 |
