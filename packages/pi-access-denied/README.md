# pi-access-denied

把 `write` / `edit` / `bash` 关进项目目录的沙箱 —— 访问项目外的路径必须先经过你的授权。

## 为什么需要它

默认情况下，pi 的 `write`/`edit`/`bash` 可以读写系统里 agent 有权限的任何文件。
这个扩展加了一层访问边界：**项目目录之外 = 需要授权**。

> 关于 pi 自带的 "trusted projects"：那是控制「是否加载某个项目的本地配置 / 资源 / 扩展」（防恶意 `.pi/settings.json` 执行代码），语义是代码执行信任。本插件做的是「限制 agent 工具的文件访问范围」，是正交的另一件事，因此**不复用** trust 存储，只借鉴了 `ask / always / never` 的三态交互。

## 三种模式

| 模式 | 行为 |
|------|------|
| `prompt` 授权 | 越界时弹窗，你来决定（默认） |
| `deny` 一律拒绝 | 越界直接 block，不问 |
| `allow` 一律通过 | 等于关掉插件（放行） |

授权弹窗的四个选项（仅 `prompt` 模式）：

- **Accept (this once)** —— 本次放行
- **Always accept (remember path this session)** —— 记住该路径，会话内不再问
- **Deny** —— 本次拒绝，弹一次理由输入框（可留空，留空用默认理由）
- **Always deny (remember path this session)** —— 永久拒绝该路径（会话内），同样弹理由输入框

拒绝的理由会作为 block 原因回传给 LLM，便于它理解为什么被拒。

「总是」的记忆**按规范化后的目标路径**保存，**仅限当前会话** —— 重启 pi、`/reload`、`/new`、`/resume` 都会清空。

## 安装

在 `~/.pi/agent/settings.json` 的 `extensions` 数组里加上本包路径：

```jsonc
{
  "extensions": [
    "/Users/chien/Projects/pi-extensions/packages/pi-access-denied"
  ]
}
```

然后 `/reload`（或重启 pi）。状态栏会出现 `🔐 access:prompt` 之类的提示。

## 配置

在 `settings.json`（全局 `~/.pi/agent/settings.json` 或项目级 `.pi/settings.json`，项目覆盖全局）的 `accessDenied` 字段下：

```jsonc
{
  "accessDenied": {
    "mode": "prompt",                    // prompt | deny | allow，默认 prompt
    "extraAllowedDirs": [                // 额外的完整可读写根目录（~ 和 $HOME 可用）
      "~/Documents/notes",
      "/tmp/build-out"
    ],
    "extraSafePaths": [],                 // 细粒度的安全路径，永远不弹窗
    "allowTempDir": true,                 // 放行 os.tmpdir()（per-user temp），默认 true
    "tools": ["write", "edit", "bash"]   // 拦截哪些工具，默认这三项
  }
}
```

## 内置安全路径（永远不弹窗）

无论 allowlist 如何，以下路径默认放行，因为它们是进程内部或正当 temp 用途：

- **伪设备**：`/dev/null`、`/dev/stdin`、`/dev/stdout`、`/dev/stderr`、`/dev/zero`、`/dev/urandom`、`/dev/random`、`/dev/fd/`（进程自己的 fd）
- **用户 temp 目录**：`os.tmpdir()`（macOS 的 `/var/folders/.../T/`、Linux 的 `/tmp`，per-user 隔离 + 系统自动清理）—— `allowTempDir: false` 可关闭

不放行的：`/dev/tty`（能读键盘输入）、`/dev/disk*`（块设备）、系统共享的 `/tmp`（仅 Linux 上 `os.tmpdir()` 恰好是 `/tmp` 时才会随 `allowTempDir` 放行）。

可以用 `extraSafePaths` 追加自定义安全路径（比如某个总在读的日志目录）。

## 命令

```
/access-denied              # 查看状态（模式、allowlist、会话内记忆）
/access-denied prompt       # 切到授权模式
/access-denied deny         # 切到一律拒绝
/access-denied allow        # 切到一律通过
/access-denied reset        # 清空会话内的 always-allow / always-deny 记忆
```

## 路径判定

**允许目录（allowlist）** = 当前项目 `cwd` + 配置里的 `extraAllowedDirs`。
目标路径 `resolve + normalize` 后，落在任一允许目录内（含其自身）即放行，否则触发授权。

- **`write` / `edit`**：直接取 `path` 参数，精确判定。
- **`bash`**：启发式扫描命令字符串，只对**明显越界**的 token 判定 ——
  - 以 `/` 开头的绝对路径
  - `~` / `$HOME` 开头
  - `..` 向上越界（`../x`、`a/..`、`a/../b`）

  在 `cwd` 下的相对路径（如 `src/foo.ts`、`cat README.md`）默认安全，不拦截。

## 局限性（bash 启发式）

bash 命令是任意 shell 字符串，**无法做到完美的静态路径分析**。已知盲区：

- **未展开的 `$VAR`**（除 `$HOME` 外）无法判定，会被跳过（放行）。例如 `cat $SECRET_FILE`。
- **命令替换 / 管道动态产生的路径** 看不见，例如 `cat $(somecmd)`、`echo {a,b}` 展开。
- 含 `$VAR` 的赋值如 `X=/etc/passwd` 一般不触发实际访问，会被跳过。
- 复杂引号 / 转义理论上可能误判。

这是「保护层」而非「绝对沙箱」—— 它能挡住绝大多数直白的越界访问（`cat /etc/passwd`、`rm ~/notes`、`echo x > /etc/foo`），但挡不住刻意绕过。如果你需要强隔离，请配合 pi 的容器化 / SSH 远程执行等机制。

## 非交互模式

在 `-p`（print）、`--mode json`、`--mode rpc` 且无 UI 的场景下，`prompt` 模式无法弹窗，此时**安全优先**：越界访问会被 block（理由为 `no UI to authorize`）。想在这些模式下放行，把 `mode` 设成 `allow`。

## 设计要点

- **会话级状态**用 `globalThis` 存储（守 monorepo 规范，规避 pi 绝对路径加载导致的 module identity 问题）；`session_start` 时重置为配置默认值。
- **不持久化授权记忆** —— 这是刻意设计，重启即忘记，避免长期授权累积成隐患。
- 拦截走 pi 的 `tool_call` 事件，返回 `{ block: true, reason }`；拒绝理由会作为 block 原因回传给 LLM。
