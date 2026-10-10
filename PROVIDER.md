# Provider 开发方法论

> 写给 agent 的指南——agent 知道怎么写代码和发测试请求，缺的是判断框架：哪些东西不能靠文档猜、必须实测验证。

## 核心原则

**文档是线索，API 响应是真相。** 写 provider 就是填静态配置，但配置的每一项值必须来自实际 API 行为，不能来自文档假设。"OpenAI 兼容"≠ 完全兼容，一定有某个维度不兼容——找到它。

## 必须实测验证的维度

以下每个维度，文档说了不算，必须发请求确认。验证方法：用该 provider 的 API 发一个请求，看响应结构。

| 维度 | 为什么不信任文档 | 验证方式 |
|------|-----------------|---------|
| **thinking 参数格式** | 每种“兼容”格式的参数名和层级都不一样；pi 支持多种格式，错了不会报错但 reasoning 静默失效 | 开关 thinking 各发一次请求，看 API 接受哪种参数格式 |
| **system prompt role** | 部分服务只接受 `system` 不接受 `developer`，反之亦然 | 引用现有模型的 compat 看哪个不 400 |
| **tool call 流式 delta 格式** | "OpenAI 兼容"在这里偷工减料最常见——delta 路径、字段名常有细微差异 | 发一个带 tool 的请求，确认流式返回结构 |
| **usage 是否在流中返回** | 很多兼容实现流式末尾不发 usage，pi 按配置决定怎么取 | 看 streaming 最后有没有 usage 字段 |
| **max_tokens 字段名** | OpenAI 自己都用两套：`max_tokens` vs `max_completion_tokens` | 测试确认 |
| **context overflow 错误消息** | 每个 provider 的错误消息格式不同；pi 靠模式匹配触发自动 compact，不认识的格式 compact 不生效 | 故意发一个超 context window 的请求，看错误消息；如果不匹配 pi 已知模式，需要 `message_end` hook 改写 |

## 可以引用文档但建议交叉验证的维度

这些通常从文档/模型卡片获取，但与 API 实际返回冲突时以实际为准：

- 模型 ID 列表 → 调 `/v1/models`（如果有）交叉验证；不少平台的这个端点还返回 `context_window` / `max_output` 等结构化元数据，比模型卡片更可靠
- context window 大小。注意宣告值与网关实际拦截上限可能不同（实测过宣告 512K、网关 1M 才拦的组合）——插件按宣告值保守声明，实测拦截上限记在源码注释里
- 最大输出 token 数
- 是否支持图片输入
- 是否支持 reasoning（注意：有的模型文档说支持，但只能开不能关，此时需 `thinkingLevelMap: { off: null }`）
- 定价（cost 字段）— **供用户参考而非真实计费**（pi 据此在状态栏显示估算成本）：
  - 填**非折扣**价格——最常用的常规期价（非活动期/非促销价），不用限时优惠或免费体验价
  - **未公布价格的模型直接填 0**（`{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`），绝不编造看似精确的数字
  - 订阅制（按月/按套餐计费）填 0

## 同模型多网关：模型真相与网关行为分开看

热门模型往往已出现在 pi 内置数据里（`pi-ai/dist/providers/data/*.json`——同一模型在原生 provider 和各中转网关下各有一条）。为新网关写 provider 时：

- **模型级真相**（thinking 档位集合、context、模态）拿内置数据中**原生 provider 的条目**做基准交叉验证。各家网关对同一模型的裁剪应当一致或是其子集；发现更多档位时查网关文档确认是谁在做映射（如网关把 low/medium 映射成 high——此时按原生惯例隐藏别名档位，不要暴露等价假档）
- **传输级 compat**（thinkingFormat、role、usage 流式位置）永远是网关自己的，不能抄任何现成条目。同一模型在不同网关下参数面不同是常态：glm-5.2 在 zai 原生用 `"zai"` 格式、Qwen Token Plan 用 `"qwen"`、云知声用 `thinking:{type}` + `reasoning_effort`，三套互不兼容

## 模型目录动态刷新（refreshModels）

静态 `models` 数组在模型上下线时要发版维护。上游有机器可读目录端点时，用 pi 的 `refreshModels` 两阶段机制让目录跟随实时 API。参考实现：`packages/pi-provider-sensenova`（含离线单测）。

### 先判定值不值得上

三个条件同时满足才上，否则维持静态：

1. **目录会变**——上游持续上新/下架，静态维护成本真实存在
2. **端点存在且结构化**——实测确认目录端点（OpenAI 兼容的 `/v1/models` 或等价物）返回结构化元数据：context window、max output、模态、定价，而不只是 id 列表
3. **端点是权威**——返回的列表就是这个 provider 的真值，不是"他们的列表有问题"；多通道上游各通道 base URL 的 `/models` 天然只含该通道

目录端点缺元数据也可以上——字段缺失时逐层回退（见回退矩阵）——但要接受新模型只有家族默认的降级。

**通道 ≠ 模型集，目录即真值。**同一上游的双注册（PAYG / 订阅）只是计费方式不同，模型宇宙相同——端点返回什么就全量注册什么，不要用"第三方模型走原生更好"之类的策划去过滤（pi 内置数据本来就同模型多网关并存，重复注册无害，选择权在用户；本仓库旧 unisound 只收 U2 家族的策划已因此废弃）。**权益在 key 不在目录**：端点不按 key 权限过滤是正常且无害的（实测：u2-flash-only 试用 key 看到全平台目录），模型能不能调是 key 与计费的事，注册侧无需也无法感知。同一上游的多个注册各自收到独立的 `refreshModels` 调用（凭据、store 按注册 id 解析），互不干扰。

### pi 的调度机制（不要自己造）

- **离线阶段**（每次会话创建，所有模式）：pi 自己读 `~/.pi/agent/models-store.json`，把快照作为 `context.stored` 传入，`allowNetwork: false`
- **网络阶段**（交互/RPC 启动后 fire-and-forget，15s 上限；模型选择器打开时也会触发）：解析出凭据后才调扩展，`allowNetwork: true`；扩展抛错只进 errors map，**上一份列表保留**——失败回退是框架保证，不要自己造
- **替换语义**：扩展返回的数组经 composer **整体替换**静态 `models`，不是合并——下架模型要消失，这正是目的；想要 merge 语义做不到（扩展路径只有替换）
- **`publish({ persist })`**：store 写入由 pi 代办（generation 校验、竞态 supersede）；扩展只决定持久化什么
- **触发时机扩展无法拒绝**：能控制的是被调用后要不要真发网络请求——这正是 `force` 参数的用途

### 实现清单

1. **静态列表改角色**：`FALLBACK_MODELS` 从唯一事实降级为三重用途——首启动引导、已知规格来源（建 `KNOWN_MODELS` Map，远程条目缺 `context_length`/`max_output_length`/`pricing`/模态/reasoning 时按 id 回退）、网络永不成功时的保底
2. **TTL 窗口**：快照新于 4 小时（与 pi 内置远程目录 `REMOTE_CATALOG_REFRESH_INTERVAL_MS` 一致）时跳过网络往返直接返回恢复的快照；`context.force`（`pi update --models`）绕过窗口
3. **空目录守卫**：过滤后零个 chat 模型视为 API 异常，抛错让 pi 保留旧列表，绝不清空模型
4. **过滤规则**：图片生成模型按 `output_modalities` 含 `"text"` 排除；旧格式目录缺模态时用 id 前缀启发式兜底（注意正则边界，别误伤 `u12` 这类同前缀 id）
5. **超时与 abort**：自带 10s 超时，级联外层 `context.signal`，`finally` 清理监听器
6. **传输级 compat 不动**：`thinkingLevelMap`/`compat` 是实测过的 wire contract（见上），不从目录映射——目录只提供模型级事实（id、context、模态、定价、是否 reasoning）

### 目录字段缺失的回退矩阵

逐字段三层回退：**目录值 > 同 id 已知规格（KNOWN Map）> 家族默认**。目录值只要存在就赢（如 unisound 目录的 `max_output: null` 回退到已知 64K 占位）。

| 字段 | 目录字段（各方言） | 已知规格回退 | 最终家族默认 |
|---|---|---|---|
| contextWindow | `context_length` / `context_window` | 已知值 | 256K |
| maxTokens | `max_output_length` / `max_output` | 已知值 | 64K |
| name | `name` | 已知名 | id |
| input 模态 | `input_modalities`（滤出 text/image） | 已知值 | `['text']`（agnes 家族例外：text+image） |
| reasoning | `supported_features` 含 `reasoning`（sensenova 方言） | 已知值 | true |
| cost | `pricing` 对象（sensenova 方言） | 已知值（含通道计费差异） | 0 |
| **thinkingLevelMap** | **永不从目录来** | 已知值 | 网关默认档位表（如 toggle / low-med-high） |
| **compat** | **永不从目录来** | 已知值 | 网关默认 compat |

compat / thinkingLevelMap 是传输级 wire contract——网关属性而非模型属性（thinkingFormat、maxTokensField、roles 在同一网关下全模型一致），目录端点不提供也不该猜：已知模型用实测规格，目录新模型继承该网关的默认契约。唯一的 per-model 传输差异（如 unisound 的 `reasoning_effort` 是否被 honoring）只能实测/文档确认，未知模型保守取 false。这与「同模型多网关」一节的边界一致：模型级真相目录能给就目录给，传输级契约永远实测。

### 静态规格表的维护义务

KNOWN 表是 compat / thinkingLevelMap 的唯一来源（目录永不提供），而它的模型级真相又是从 pi 内置条目 / 上游目录抄的**时点快照**——pi 内置更新了、上游目录变了，快照不会自己动。因此接入动态刷新后静态表仍需定期对齐两个真值源：

1. **上游目录**（ids、ctx/out）：过时的后果是下架模型赖在 KNOWN、新模型拿不到已知规格——动该包时顺手用 key 拉一次 `GET /v1/models` 核对（实测案例：sensenova 静态表曾滞后到 2 个下架 + 2 个上新 + kimi-k3 规格漂移）
2. **pi 内置原生条目**（第三方模型的档位/模态真相）：pi 更新内置数据后同 id 快照会漂移——**thinking 档位表优先核对**，档位错＝reasoning 静默失效无报错；模态/ctx 错只是体验降级

漂移短期可容忍（ids/ctx/out 由目录刷新兑住），但传输级字段只能靠插件发版纠正——这正是静态表从"唯一事实"降级为"规格快照 + 回退层"后仍然要维护的原因。

### 测试要求
### 测试要求

全部离线：fetch stub + `finally` 恢复，不碰网络。覆盖：注册、离线恢复（跳过非 chat 条目）、映射/过滤/持久化、TTL 窗口跳过、force 绕过、已知规格回退、无 key、HTTP 错误、异常响应结构、空目录拒绝。参考 `pi-provider-sensenova/src/index.test.ts`。

### 本仓库 provider 的适配现状（2026-10 实测）

- `pi-provider-unisound` — **适配，收益最大**：`GET /v1/models` 200，22 个模型带 `context_window`/`max_output`（`u2-med` 缺 max_output，已知规格兜底）；静态 6 个 vs 线上 22 个（qwen3.8/glm-5.3/deepseek-v4 等主力缺失）。模态/reasoning/pricing 端点不返回，靠 KNOWN_MODELS 兜底；线上全是 chat 模型，无需图片过滤。plan 通道用独立 key，其目录是否随 key 变化待实测
- `pi-provider-agnes` — **可适配，元数据最弱但需求真实**：`GET /v1/models` 200，12 个条目仅 `id`/`owned_by` 无任何元数据；静态 3 个中 `agnes-1.5-flash` 已下架、缺 5 个新 chat 模型。目录含 `agnes-image-*`（3 个）与 `agnes-video-*`（2 个）生成模型，需按前缀过滤（比 sensenova 多一类 video）；新模型降级为 text-only + 通用默认
- `pi-provider-stepfun` — **待实测**：两通道路由均存在（`/v1/models`、`/step_plan/v1/models` 均返 401 非 404），但本机无 key，响应结构与元数据覆盖度未验证；拿到 `STEP_API_KEY` / `STEP_PLAN_API_KEY` 后一次探测即可判定

## 常见误判

- **"这是 OpenAI 格式，默认 compat 就行"** → 每个 compat flag 都是因为有某个 provider 在某处不符合 OpenAI 标准才产生的。不测就设默认值，等于猜。
- **"文档没提，说明不支持"** → 反过来也成立：文档没提不代表不支持。比如很多模型实际支持图片输入但文档没写。
- **"和其他 provider 差不多，复用 compat"** → 不同 provider 的"兼容"偏差各不相同，不能套用。
- **"thinking 格式用最常见的就行"** → thinking 是 API 调用层面的事，格式错 reasoning 静默不工作，无报错、无提示，排查极其困难。
- **"目录列表需要我策划"** → 端点列表就是 provider 真值：不要替用户挑选（"第三方走原生更好"之类），权益在 key 不在目录，重复注册无害；唯一正当的过滤是模态（图片/视频生成模型不是 chat）。
- **"动态刷新＝每次启动都 fetch"** → pi 内置远程目录自带 4h freshness 窗口，`force` 就是留给 provider 自律的——无条件 fetch 是把 freshness 层丢掉了；目录字段缺失时也不该静默落通用默认值，先回退同 id 已知规格。

## README 与内部记录

- **README 面向用户**：英文撰写（可含中文专有名词），只写用户需要的内容——provider/model 表、安装配置、行为事实（reasoning 档位、图片支持、定价参考）。维护指令与实测过程不进 README。
- **实测记录进源码注释或 plans/**：wire-contract 验证结论写在 `src/index.ts` 头注释，集成计划写 `plans/`。README 会被渲染在 npm 与 pi-catalog 上，引用包目录外的仓库文件（如 `../../PROVIDER.md`）是死链。

## 参考

- pi provider API 文档：`@earendil-works/pi-coding-agent` 的 `docs/custom-provider.md`
- 本仓库现有 provider：`packages/pi-provider-agnes`（动态刷新、id-only 目录）、`packages/pi-provider-sensenova`（动态刷新参考实现，元数据最全）、`packages/pi-provider-stepfun`（动态刷新待 key 实测）、`packages/pi-provider-unisound`（动态刷新、双通道共享目录）
