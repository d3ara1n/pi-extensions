# pi-subagent — v1 收尾：subagent_cancel 与 /subagent:view

> 状态：已交付。cancel 与用户侧 view 均已实现；view 后续在 v2 工作中扩展为会话档案。RPC transport 与 steer 的交付记录见 [v2](./pi-subagent-v2.md)。

## subagent_cancel

- `subagent_cancel(id, reason?)` 取消排队中或运行中的后台任务；`/subagent:cancel <id|all> [reason]` 是用户侧入口。用户给出的理由以 `cancelled by user: <reason>` 记录，不填则为 `cancelled by user`。
- 取消沿用 AbortController 与进程终止链（SIGTERM，5 秒后必要时 SIGKILL）；终态为 `stopReason: "cancelled"`，保留部分输出与活动历史，并用 warning 色呈现。
- 取消工具只确认结果，不交付部分输出。`subagent_wait` 返回终态状态，`subagent_check` 可读取完整快照；终态 check 可重复调用，收件箱提醒是否已交付由当前 session branch 判定。
- 仅后台任务可由工具或命令取消。已结束的任务不能再次取消，排队任务可以取消。

## /subagent:view

- `/subagent:view` 与命令面板入口打开同一个居中 TUI overlay；没有任务时显示空态。
- view 是当前会话的运行档案：前台与后台任务都保留，结束或通过 check 交付后也不会从面板消失。新增任务和活动在打开期间持续更新。
- 标签栏按新到旧列出任务，Tab / Shift+Tab 切换；每个任务有可滚动的活动页和展示输入、文件、用量等信息的详情页，`d` 切换页面。
- `s` 打开当前运行任务的 steer 输入，Enter 排队发送；该消息在活动流中先显示为 queued，子进程消费后原位更新。浏览模式 Esc 关闭面板。

## 与原草案的差异

- 最初计划 view 只展示尚未收集的后台任务、复用 wait 的逐任务块布局；实际实现改为独立的标签式会话档案，同时收录前台任务。
- steer 原划入 v2，最终与 view 的用户侧输入一起交付；transport 迁移使用裸 `--mode rpc` JSONL，而非草案中的 RpcClient。详见 [v2 交付记录](./pi-subagent-v2.md#交付记录2026-08-23)。
