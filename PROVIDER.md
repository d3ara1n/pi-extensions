# Provider 开发方法论

> 写给 agent 的指南——agent 知道怎么写代码和发测试请求，缺的是判断框架：哪些东西不能靠文档猜、必须实测验证。

## 核心原则

**文档是线索，API 响应是真相。** 写 provider 就是填静态配置，但配置的每一项值必须来自实际 API 行为，不能来自文档假设。"OpenAI 兼容"≠ 完全兼容，一定有某个维度不兼容——找到它。

## 必须实测验证的维度

以下每个维度，文档说了不算，必须发请求确认。验证方法：用该 provider 的 API 发一个请求，看响应结构。

| 维度 | 为什么不信任文档 | 验证方式 |
|------|-----------------|---------|
| **thinking 参数格式** | 每种"兼容"格式的参数名和层级都不一样；pi 支持 10 种格式，错了不会报错但 reasoning 静默失效 | 开关 thinking 各发一次请求，看 API 接受哪种参数格式 |
| **system prompt role** | 部分服务只接受 `system` 不接受 `developer`，反之亦然 | 引用现有模型的 compat 看哪个不 400 |
| **tool call 流式 delta 格式** | "OpenAI 兼容"在这里偷工减料最常见——delta 路径、字段名常有细微差异 | 发一个带 tool 的请求，确认流式返回结构 |
| **usage 是否在流中返回** | 很多兼容实现流式末尾不发 usage，pi 按配置决定怎么取 | 看 streaming 最后有没有 usage 字段 |
| **max_tokens 字段名** | OpenAI 自己都用两套：`max_tokens` vs `max_completion_tokens` | 测试确认 |
| **context overflow 错误消息** | 每个 provider 的错误消息格式不同；pi 靠模式匹配触发自动 compact，不认识的格式 compact 不生效 | 故意发一个超 context window 的请求，看错误消息；如果不匹配 pi 已知模式，需要 `message_end` hook 改写 |

## 可以引用文档但建议交叉验证的维度

这些通常从文档/模型卡片获取，但与 API 实际返回冲突时以实际为准：

- 模型 ID 列表 → 调 `/v1/models`（如果有）交叉验证
- context window 大小
- 最大输出 token 数
- 是否支持图片输入
- 是否支持 reasoning（注意：有的模型文档说支持，但只能开不能关，此时需 `thinkingLevelMap: { off: null }`）
- 定价（cost 字段）— **供用户参考而非真实计费**（pi 据此在状态栏显示估算成本）：
  - 填**非折扣**价格——最常用的常规期价（非活动期/非促销价），不用限时优惠或免费体验价
  - **未公布价格的模型直接填 0**（`{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`），绝不编造看似精确的数字
  - 订阅制（按月/按套餐计费）填 0

## 常见误判

- **"这是 OpenAI 格式，默认 compat 就行"** → 每个 compat flag 都是因为有某个 provider 在某处不符合 OpenAI 标准才产生的。不测就设默认值，等于猜。
- **"文档没提，说明不支持"** → 反过来也成立：文档没提不代表不支持。比如很多模型实际支持图片输入但文档没写。
- **"和其他 provider 差不多，复用 compat"** → 不同 provider 的"兼容"偏差各不相同，不能套用。
- **"thinking 格式用最常见的就行"** → thinking 是 API 调用层面的事，格式错 reasoning 静默不工作，无报错、无提示，排查极其困难。

## 参考

- pi provider API 文档：`@earendil-works/pi-coding-agent` 的 `docs/custom-provider.md`
- 本仓库现有 provider：`packages/pi-provider-agnes`（简单）、`packages/pi-provider-sensenova`（最简）
