# pi-apply-patch — Codex 兼容的工作区补丁工具

> 状态：已实现，待加载后进行真实模型验收。实现与测试见 `packages/pi-apply-patch/`。

## 目标与范围

为习惯 Codex `apply_patch` 的模型提供同名 freeform 工具。模型侧格式及编辑行为以固定版本的官方源码与测试为基准；内部使用 TypeScript 纯函数与 pi 扩展 API。

- 包：`@d3ara1n/pi-apply-patch`
- 工具名固定为 `apply_patch`，内部参数为 `input: string`
- 无配置、无额外运行库依赖
- 插件自身限制访问当前 `ctx.cwd` 工作区；不接入 pi-access-denied
- 不覆盖其他编辑工具，不安装 shell shim，不提供多环境路由

## 兼容基线

OpenAI Codex 提交：`b04a2c264516ec2e6b3c91dd73ad18a21fd5a88f`。

采用该版本默认的 `NormalizeToLf` 行处理语义，未启用实验性的 `PreserveLineEndings`。

- 使用官方 Lark grammar，通过 `constrainedSampling` 注册。
- 模型的 `compat.supportsOpenAIGrammarTools` 决定是否声明为 custom grammar 工具；不支持时由 pi 回退为 function 工具。
- pi 负责 freeform 原文包装、工具结果配对与历史回放转换。
- 更新按游标顺序搜索；精确匹配、忽略行尾空白、忽略首尾空白、有限 Unicode 归一化依次尝试。
- `@@ text` 表示找到该上下文行后继续搜索；纯新增 chunk 追加到文件末尾。
- Add 可以覆盖，Move 先写目标再删源；允许工作区内绝对路径。
- 完整解析与整体预校验在写入前完成；落盘阶段失败可能部分生效，不提供事务回滚。

官方 grammar 与 fixtures 原样保留，算法移植注明出处，包使用 Apache-2.0 许可证。

## 实现结构

```text
src/core/       纯解析、匹配、更新函数与测试
src/grammar.ts  官方 Lark grammar
src/workspace.ts 工作区路径解析与文件系统接口
src/apply.ts    文件准备、队列、重校验和落盘
src/tool.ts     工具定义与 execute
src/render.ts   JSON details、TUI 摘要和 diff
src/index.ts    注册入口
test/          内存文件系统、上游 fixtures、工具协议测试
test/integration/  真实临时目录文件操作测试
```

解析结果采用 discriminated union；源内容与 chunk 的更新逻辑不依赖文件系统或 pi。

执行层注入文件系统和文件修改队列，使用排序、去重后的 canonical 路径获取队列。路径检查覆盖源、移动目标和新文件已有祖先；在等待队列及执行文件操作时重新检查。内部符号链接保留原有文件操作语义，路径检查不是操作系统沙箱。

预校验保存旧内容与计算结果。落盘前重读源内容，内容未变则复用计算结果；如果前面的 Move 改变了后续源内容，则按当前内容重新匹配。

错误通过 throw 交给 pi 标记失败；成功返回 Codex 风格的 A/M/D 摘要。渲染数据为可序列化 details，执行不依赖 TUI。

## 验证

- 默认测试：核心语义、内存文件系统、全部上游场景 fixture、freeform/function 协议转换和历史配对、错误与渲染。
- fixture 015 按 Codex 工具整体预校验的语义断言无落盘；023/024 明确按默认行处理模式断言，与上游实验性模式的期望区分。
- 显式 integration：临时目录中的真实文件操作、符号链接越界、UTF-8 与 BOM、并发文件队列；测试负责清理。
- 全仓库 `npx tsc --noEmit`。
- 在线验收：用户加载插件并 `/reload` 或重启后，用支持 grammar 的 GPT 模型验证真实 freeform 多文件编辑。
