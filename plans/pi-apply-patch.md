# pi-apply-patch — 接住 code-mode 模型的 apply_patch 调用（设计计划）

> **状态：计划中，待实施**（2026-09 讨论定稿）

## 背景与动机

经 sub2api 等网关接入的 code-mode 模型（gpt-5.6-sol / terra / luna 一组，sub2api 元数据 `tool_mode: "code_mode_only"`、`apply_patch_tool_type: "freeform"`）以 Codex 环境为训练基座，**编辑文件的先验动作就是 apply_patch**，与客户端实际声明了什么工具基本无关。在 pi 里表现为两条失败路径：

1. **freeform 路径**：模型发出 `custom_tool_call`（name=`apply_patch`，input=patch 原文）。pi 的 Responses 协议层已能把它包装成普通 toolCall（`arguments: { input: patch }`，见 pi-ai `openai-responses-shared.js` 的 custom_tool_call 分支），但因上下文里没有注册过名为 `apply_patch` 的工具而失败。
2. **bash 路径**：模型往 bash 命令里写 `apply_patch <<'EOF' ...` heredoc，shell 里没有这个命令，直接报错。

路径 1 已在协议层解决了一半——**只差一个同名的 pi 工具本体把它接住**。路径 2 属 shell 层，见「范围外」。

**目标**：注册 `apply_patch` 工具，解析并应用 Codex `*** Begin Patch` 格式，让模型两条调用形态（function JSON / freeform custom_tool_call）都落到同一 handler，编辑体验闭环。

## 范围

- 新包 `packages/pi-apply-patch`（`@d3ara1n/pi-apply-patch`），无 extension 依赖、无 npm 库依赖
- 一个工具 `apply_patch`，单参数 `input: string`（patch 原文）
- 支持格式：`*** Begin Patch` / `*** End Patch` 包裹；`*** Update File`（@@ 上下文锚定 hunk）、`*** Add File`、`*** Delete File`、`*** Move to:`（重命名）；多文件、单文件多 hunk
- 路径安全：默认只允许 cwd 内的相对路径，越界直接报错回传

**范围外（明确不做）**：

- 不覆盖 pi 内置 `edit` / `write` 工具——两者并存，模型自选（顺应先验而非对抗）
- 不做 bash heredoc 的 shell shim——README 提一句可选方案（往 PATH 装独立 apply_patch CLI）
- 不管 `collaboration.spawn_agent` 等命名空间调用——那是子代理派发，编辑工具管不了

## 架构

沿用 `pi-hashline-edit` 的两层结构：

```
src/core/          纯逻辑，无 pi 依赖，node --test 独立测试
  parse.ts         patch 文本 → ParsedPatch { files: FileOp[] }
                  FileOp = add { path, content }
                         | update { path, moveTo?, hunks: Hunk[] }
                         | delete { path }
                  Hunk = { anchor?: string（@@ 后的提示文本）,
                           lines: (context|delete|add)[] }
  apply.ts         ParsedPatch × 文件系统 → ApplyResult
                  update: 上下文锚定（见 D3）；逐 op 应用，失败即停
src/pi/
  apply-patch-tool.ts   makeApplyPatchTool(cwd)：registerTool 定义与 execute
  render.ts             TUI renderer：每文件一行 +dir/file、±N 摘要
src/index.ts       注册工具
```

## 关键决策与理由

### D1. 参数名必须是 `input`

pi 的 custom_tool_call 包装逻辑：`arguments: { [grammarToolInputProperties?.get(name) ?? "input"]: input }`。未按 grammar 声明的工具，freeform 调用会被包装成 `{ input: patch }`；而 function 路径模型按 schema 也发 `{"input": ...}`。两条形态零适配落进同一 handler，这是本包成立的前提。

### D2. 锚定算法 V1 从严：精确匹配 + 唯一性

对每个 hunk，取「上下文行 + 删除行」序列在文件全文中查找：

- 恰好 1 处命中 → 应用
- 0 处或 >1 处 → 该文件报错回传（含 hunk 首行内容、命中数），不做模糊匹配、不猜位置，让模型下一轮自纠
- `@@` anchor 文本仅用作消歧提示：多处命中时优先选 anchor 附近（同 codex 语义）

理由：apply_patch 的 hunk 无行号，宽松匹配（缩进归一、fuzz）是 codex-rs 的成熟行为但移植成本和误改风险都高；V1 宁可报错让模型重试。语义基准参照 openai/codex（Apache-2.0）的 `apply_patch` 模块测试用例，实现自写，不搬代码。

### D3. 错误走工具结果回传，不抛异常

execute 返回结构化错误文本（哪一步、哪个 hunk、什么原因），模型读后自纠。与内置 edit 工具的失败模式一致，对 code-mode 模型是最熟悉的反馈形态。

### D4. 文案分层遵守仓库约定

- tool description 写契约：接受 `*** Begin Patch` 格式、只允许 cwd 内路径、失败原因会回传
- **不写**「优先用本工具」「不要用 edit」之类引导——先验在模型侧，不需要教；也不对内置工具做对比声明
- 不注册 promptSnippet / promptGuidelines（工具名本身自带召回）

### D5. 工具名硬编码 `apply_patch`

不提供配置改名——模型先验里这个名字是固定的，改名即失效。

## 测试

- `src/core/*.test.ts`（node --test，同 hashline 布局）：
  - 格式：多文件混合、Move to、嵌套引号路径、CRLF、文件末尾无换行、空 patch、`*** End Patch` 缺失、未知段落头报错
  - 锚定：唯一命中、多处命中（anchor 消歧成功/失败）、上下文找不到、连续 hunk 位置顺延、文件首/尾追加
  - 应用：Add 覆盖已存在文件报错、Delete 不存在报错、路径越界（`../`、绝对路径）报错、原子性——同一 patch 内前一个文件成功后一个失败时整体不落盘
- typecheck：`npm run typecheck`
- 在线验收（需用户 `/reload` 后）：sub2api + gpt-5.6-sol 跑一轮真实多文件编辑任务，确认 freeform 与 function 两种调用形态都被接住且正确落盘

## 登记与发布

- 主 README Extensions 表加一行（无角标，无依赖）
- 包 README：`## Installation`（`pi install npm:@d3ara1n/pi-apply-patch` + settings.json 本地路径两式）、`## Dependencies`（None）、`## Model Compatibility` 一节写实测的 code-mode 模型行为（有真实观察，符合仓库「没有观察不写」的反向要求）
- `package.json`：keywords `pi-package` / `pi`；`pi.extensions: ["./src/index.ts"]`；peerDependencies `@earendil-works/pi-coding-agent`
- commit scope：`pi-apply-patch`

## 风险

- patch 格式边角（fuzz、缩进归一）与真实 codex 行为有差异 → V1 以报错代替猜测，实测后再决定是否放宽
- 模型偶尔会把 patch 写进 bash heredoc → 工具管不到，README 提供独立 CLI 方案兜底
- pi-ai 若调整 custom_tool_call 包装的属性名（当前 `"input"`）→ 该属性名是协议层的稳定默认值，真变了也是一行适配，风险低
