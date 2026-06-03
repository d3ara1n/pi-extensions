# Model Roles + Skill Router 双插件方案

> **状态：搁置** — pi 扩展 API 目前没有暴露"调用任意已注册模型"的能力，
> side agent 无法通过 `ctx.modelRegistry` 直接发起推理请求。
> 等 pi 提供 `ctx.modelRegistry.stream(model, messages)` 或类似 API 后可复活。

---

## 动机

1. **Model Roles**：不同任务（深度推理 / 快速编码 / 前端设计）适用不同模型，
   手动 `/model` 切换繁琐，需要一种"角色"抽象。
2. **Skill Router**：pi 的 skill 描述一次性全部注入 system prompt，
   占大量 context 且干扰模型聚焦。
   用 cheap model 每轮选 ≤5 个相关 skill 可以大幅精简 prompt。

两者共需要一个 cheap "side agent" 模型，因此设计为共享角色机制的依赖关系。

---

## 架构总览

```
用户 prompt
    │
    ▼
before_agent_start
    │
    ├─► fetch() → side-agent 模型（通过 pi 注册的 provider）
    │   输入：用户 prompt + 全部 skill 摘要 + 全部 role 定义
    │   输出：{ skills: string[], role: string }
    │
    ├─► 从 system prompt 剥离全部 skill 内容
    ├─► 只注入 side agent 选中的 ≤5 个 skill
    ├─► pi.setModel() + pi.setThinkingLevel() 切换主模型
    │
    ▼
主模型带着精简 prompt 执行任务
```

---

## 插件 1：pi-model-roles

### 职责

- 定义命名模型角色（role），每个角色 = `{ provider, modelId, thinkingLevel }`
- 提供 `/role <name>` 命令手动切换
- 可选的自动路由规则（关键词匹配或正则）
- 暴露角色配置供其他扩展读取

### 配置格式（`~/.pi/agent/model-roles.json`）

```jsonc
{
  "roles": {
    "default": {
      "provider": "anthropic",
      "modelId": "claude-sonnet-4",
      "thinkingLevel": "medium",
      "description": "日常编码，速度和质量平衡"
    },
    "heavy": {
      "provider": "anthropic",
      "modelId": "claude-opus-4",
      "thinkingLevel": "high",
      "description": "架构设计、深度调试、复杂迁移"
    },
    "fast": {
      "provider": "google",
      "modelId": "gemini-2.5-flash",
      "thinkingLevel": "off",
      "description": "快速修改、简单问答、补全"
    },
    "side-agent": {
      "provider": "google",
      "modelId": "gemini-2.5-flash-lite",
      "thinkingLevel": "off",
      "description": "内部用：skill 选择和角色推荐"
    }
  },

  // 可选：关键词自动路由规则
  "autoRoutes": [
    {
      "patterns": ["debug", "root cause", "architecture", "migration", "performance"],
      "role": "heavy",
      "minMatches": 2
    },
    {
      "patterns": ["quick fix", "simple", "rename", "patch", "minor"],
      "role": "fast",
      "minMatches": 2
    }
  ]
}
```

### 核心 API

```typescript
// 扩展暴露给其他插件（通过共享文件或 global）
interface ModelRolesAPI {
  getRoles(): Record<string, RoleConfig>;
  getRole(name: string): RoleConfig | undefined;
  switchToRole(ctx: ExtensionContext, roleName: string): Promise<boolean>;
}
```

### 核心实现

```typescript
// 读配置
function loadRoles(): Record<string, RoleConfig> { /* 读 model-roles.json */ }

// 切换模型
async function switchToRole(ctx, roleName) {
  const role = loadRoles()[roleName];
  const model = ctx.modelRegistry.find(role.provider, role.modelId);
  if (!model) return false;
  await pi.setModel(model);
  pi.setThinkingLevel(role.thinkingLevel);
  return true;
}

// 关键词自动路由（在 before_agent_start 中）
pi.on("before_agent_start", async (event, ctx) => {
  const routes = loadAutoRoutes();
  for (const route of routes) {
    const matches = route.patterns.filter(p => event.prompt.toLowerCase().includes(p));
    if (matches.length >= route.minMatches) {
      await switchToRole(ctx, route.role);
      return { systemPrompt: event.systemPrompt + `\n\n[auto-routed to ${route.role}]` };
    }
  }
});
```

### 注册的命令和工具

| 名称 | 类型 | 说明 |
|------|------|------|
| `/role <name>` | 命令 | 手动切换到指定角色 |
| `/roles` | 命令 | 列出所有角色及当前模型 |
| `switch_role` | 工具 | 让 LLM 自主切换角色 |
| `list_roles` | 工具 | 列出可用角色 |

---

## 插件 2：pi-skill-router（依赖 pi-model-roles）

### 职责

- 在每轮 `before_agent_start` 前调用 side-agent 模型
- Side agent 根据用户 prompt 从全部 skill 中选择 ≤5 个
- 同时推荐最佳 model role
- 修改 system prompt：剥离所有 skill，只注入选中的

### Side Agent 的 Prompt 设计

```
You are a skill and model router. Given a user's prompt and a list of available skills,
select up to 5 most relevant skills and recommend the best model role.

## Available Skills
1. mcp-builder: Guide for creating MCP servers...
2. brandkit: Premium brand-kit image generation...
3. minimalist-ui: Clean editorial-style interfaces...
...

## Available Roles
- default: anthropic/claude-sonnet-4, medium — 日常编码
- heavy: anthropic/claude-opus-4, high — 架构设计
- fast: google/gemini-2.5-flash, off — 快速修改
- side-agent: (你自己的角色，不会被推荐)

## User Prompt
<用户 prompt>

## Response Format (JSON only)
{
  "skills": ["skill-name-1", "skill-name-2"],
  "role": "recommended-role-name",
  "reasoning": "brief explanation"
}
```

### 核心实现

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // 1. 收集所有 skill 信息
  const skills = event.systemPromptOptions.skills; // pi 提供的已加载 skill 列表
  const skillSummaries = skills.map(s => `${s.name}: ${s.description}`).join("\n");

  // 2. 读取 model-roles 配置
  const roles = loadModelRoles();
  const roleOptions = Object.entries(roles)
    .filter(([name]) => name !== "side-agent")
    .map(([name, cfg]) => `- ${name}: ${cfg.provider}/${cfg.modelId}, ${cfg.thinkingLevel} — ${cfg.description}`)
    .join("\n");

  // 3. 调用 side-agent 模型
  const sideAgentRole = roles["side-agent"];
  const decision = await callModel(sideAgentRole, [
    { role: "system", content: SIDE_AGENT_SYSTEM_PROMPT },
    { role: "user", content: `## Skills\n${skillSummaries}\n\n## Roles\n${roleOptions}\n\n## Prompt\n${event.prompt}` }
  ]);
  // decision = { skills: [...], role: "heavy" }

  // 4. 修改 system prompt：剥离所有 skill，注入选中的
  let prompt = event.systemPrompt;
  prompt = stripAllSkills(prompt);
  prompt = injectSelectedSkills(prompt, decision.skills, skills);

  // 5. 切换模型角色
  if (decision.role) {
    await switchToRole(ctx, decision.role);
  }

  return { systemPrompt: prompt };
});
```

### 阻塞点

`callModel()` 需要能够通过 pi 注册的 provider 发起推理请求。
当前 pi 扩展 API **没有暴露**此能力：

- `ctx.modelRegistry.find(provider, modelId)` → 只能获取模型元信息
- `ctx.modelRegistry` → 不提供 `stream()` 或 `complete()` 方法
- 扩展有 `fetch()` → 可以直接调 API，但需要自行解析 provider 的 baseUrl、apiKey、API 格式

#### 可能的复活路径

1. **pi 官方支持**：`ctx.modelRegistry.complete(model, messages)` 或类似 API
2. **自己解析 models.json**：读取 `~/.pi/agent/models.json` 获取 provider 配置，
   解析 `$ENV_VAR` / `!command` 格式的 apiKey，用 fetch() 调 OpenAI 兼容 API。
   可行但需要自己处理多 API 格式（anthropic / openai / google）
3. **限制 side-agent 只用 OpenAI 兼容 API**：简化实现，但不够通用
4. **用 Ollama 本地模型**：固定 localhost，不涉及 provider 解析问题

### 注册的命令和工具

| 名称 | 类型 | 说明 |
|------|------|------|
| `/skill-router on/off` | 命令 | 开关自动 skill 路由 |
| `/skill-router status` | 命令 | 显示当前选中的 skill 和路由信息 |

---

## 依赖关系

```
pi-model-roles  ←──  pi-skill-router
   (独立)           (读取 model-roles.json，
                     调用 side-agent 角色定义的模型)
```

两个扩展通过共享配置文件 `model-roles.json` 解耦，不需要运行时导入。

---

## 目录结构

```
packages/
  pi-model-roles/
    package.json
    src/
      index.ts           # 扩展入口，注册事件/命令/工具
      roles.ts           # 角色配置读写、切换逻辑
      auto-route.ts      # 关键词自动路由
    README.md

  pi-skill-router/
    package.json
    src/
      index.ts           # 扩展入口
      side-agent.ts      # side agent 调用逻辑（阻塞点）
      skill-parser.ts    # system prompt 中 skill 的解析和替换
      prompt.ts          # side agent 的 system prompt 模板
    README.md
```

---

## 参考实现

- [umgbhalla/pi-config/extensions/model-router.ts](https://github.com/umgbhalla/pi-config/blob/main/extensions/model-router.ts)
  — 手动规则路由，关键词匹配 + pi.setModel() 切换
- [kdejaeger/pi-model-router](https://github.com/kdejaeger/pi-model-router)
  — 注册为 router provider，自动选 high/medium/low
- [pi extension API: before_agent_start](https://pi.dev/docs/latest/extensions#before_agent_start)
  — system prompt 修改和模型切换的钩子
- [pi extension API: modelRegistry](https://pi.dev/docs/latest/extensions#ctxmodelregistry--ctxmodel)
  — 模型发现和验证

---

## 未来展望

如果 pi 未来暴露了 `ctx.streamModel(model, messages)` 或类似 API，这个方案可以立即实施。
届时还可以扩展 side agent 的能力：

- 根据上下文大小自动降级模型（context 快满时切到更大窗口的模型）
- 根据会话累计成本动态调整角色
- 学习用户习惯，个性化路由权重
