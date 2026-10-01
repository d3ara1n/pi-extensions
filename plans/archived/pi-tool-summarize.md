# pi-tool-summarize — 工具结果摘要（已被取代）

> **状态：已被 pi 内置 codemode 取代（2026-09-30 归档）**。
> 核心场景（一次读大量日志定位问题）codemode 解决得更优：脚本内 `tools.<name>()` 真实调用
> 保留权限拦截，bash 输出上限 1 MiB，JS 确定性过滤后再给模型，零额外成本。
> 残余的“LLM 摘要”需求 codemode 做不了（chat 模型不能从 script 调用）；真需要时
> 用小扩展包 `pi-model-roles` 的 `completeWithRole("utility", ...)` 实现，无需恢复本计划。

## 需求

- 提供独立的 summarize 工具：模型提交一个现有工具调用及其参数，例如 `summarize(read(path))`；先执行该工具，再把结果交给 utility 模型摘要，主模型只消费摘要。目标是一次性阅读大量内容（如日志中定位问题），并可扩展到其他工具结果。
- 被包装的工具调用须独立经过原有的参数校验、`tool_call` 权限拦截、`tool_result` 处理及错误语义；不能因为加了一层摘要就绕过原工具的执行边界。

## 现状

- 仓库已有 `pi-model-roles` 的 `completeWithRole("utility", ...)`，可发起 utility 模型请求；缺口不在模型调用本身。
- pi 扩展的 `pi.getAllTools()` 仅提供工具元数据，没有公开 API 让 summarize 按名称执行传入的工具调用并取得经原生事件链处理的最终结果。直接读取文件或直接调用 `read.execute()` 可以做特定文件摘要，但不符合“包装现有工具并保留其完整校验”的需求。
- 因此通用的 `summarize(toolCall)` 目前无法仅通过独立扩展实现；与 pipeline 依赖同一个受控子工具分发 API。未开始实现。
