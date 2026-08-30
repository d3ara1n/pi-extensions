# pi-access-denied

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-access-denied)](https://www.npmjs.com/package/@d3ara1n/pi-access-denied) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-access-denied)](https://www.npmjs.com/package/@d3ara1n/pi-access-denied) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-access-denied)](https://www.npmjs.com/package/@d3ara1n/pi-access-denied)

Behavior guard for `write` / `edit` / `bash` path choices. It nudges an agent back toward the project when it tries broad disk searches, reaches for stale sensitive-data locations, or writes persistent data outside the working directory.

## Why

LLMs sometimes choose unnecessarily broad or misplaced paths: `find /` instead of searching the project, an application data directory remembered from training data, or a home-directory output path when the result belongs in the repository. This extension catches common forms of those calls and either asks you, redirects the agent with a reason, or blocks the call according to your selected mode.

It is a **behavior-correction layer**, not a security sandbox. Bash commands are parsed structurally (not flat-tokenized) so that quoted text and nested commands are handled correctly; because perfect static matching is impossible, matching is best-effort and biased toward low noise — missing an unusual path expression is preferable to interrupting ordinary commands with false positives. Use OS/container isolation when access must be enforced against deliberate or comprehensive evasion.

> Pi's built-in "trusted projects" controls whether project-local config, resources, and extensions may load. This extension instead influences agent tool behavior after loading; it does not reuse or replace pi's trust model.

## Three modes

| Mode | Behavior |
|------|----------|
| `prompt` | Ask the user on each out-of-bounds access (default) |
| `deny`  | Block every out-of-bounds access without asking |
| `allow` | Passthrough (effectively disable the gate) |

Authorization panel (`prompt` mode only):

When a recognized tool call contains a path outside the configured roots, a bottom-anchored panel lists each matched path on its own row, defaulting to **Allow**. A single horizontal action bar reflects the focused path's current choice:

- **Allow** (default) — allow this one call; shows no marker on its row
- **Always allow** — remember the path **and everything beneath it**, don't ask again this session; marks the row `[always-allow]` (green)
- **Deny** — block this one call; marks the row `[deny]` (red)
- **Always deny** — block that path **and everything beneath it** for the rest of this session; marks the row `[always-deny]` (red)

Each path keeps its own choice, so a multi-path `bash` call can allow some paths while denying others in a single pass. Submitting with any deny present pops a **single global reason** input (leave empty for a default reason); **Esc there returns to the path list** rather than committing a no-reason deny.

Keys: `↑`/`↓` move path focus · `←`/`→` change the focused path's action (no wrap) · `Tab` cycles the action (wraps) · `Enter` submit · `Esc` cancel the whole authorization (or, in the reason input, go back to the path list).

"Always" memory uses **prefix coverage** (not exact paths): authorizing `/a/b` also covers `/a/b/c`, `/a/b/c/d`, … so you never get re-prompted for a path whose ancestor you already decided on. When you remember a **broader** path, any narrower entries it now subsumes are dropped, keeping the list minimal and the status view free of "parent listed next to its own child" oddity. Memory is **session-only** — restarting pi, `/reload`, `/new`, `/resume` all clear it.

## Dependencies

None.

## Installation

```bash
pi install npm:@d3ara1n/pi-access-denied
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-access-denied"
  ]
}
```

Then `/reload` (or restart pi).

## Configuration

Under the `accessDenied` key in `settings.json` (global `~/.pi/agent/settings.json` or per-project `.pi/settings.json`). A present project `accessDenied` block replaces the global block; fields omitted from the selected block use their defaults:

```json
{
  "accessDenied": {
    "mode": "prompt",
    "allowedPaths": [
      "~/Documents/notes",
      "/var/log/myapp"
    ],
    "deniedPaths": [
      { "paths": ["~/.config/X/data"], "reason": "X data moved to ~/MyData/X; use the new location" },
      { "paths": ["/old/cache"] }
    ],
    "tools": ["write", "edit", "bash"]
  }
}
```

### Rule resolution: longest-prefix-match

All rules — built-in safe paths, `allowedPaths`, `deniedPaths`, and runtime session decisions — are resolved by a **single** algorithm: the most specific (deepest) rule covering a target wins, regardless of which layer it came from.

```
allow /aaa/bbb     deny /aaa/bbb/ccc     deny /aaa
```

| Target | Winner | Result |
|--------|--------|--------|
| `/aaa/bbb/ddd` | `allow /aaa/bbb` (depth 2) | ✅ allow |
| `/aaa/bbb/ccc/ddd` | `deny /aaa/bbb/ccc` (depth 3) | ❌ deny |
| `/aaa/ccc` | `deny /aaa` (depth 1) | ❌ deny |

A same-depth allow/deny conflict (same path in both lists) resolves to **deny** — the safe default. Session decisions are equal peers: a runtime "always-allow `/a/b/c`" overrides a config "deny `/a/b`" for that subtree, exactly as two config rules would.

### `deniedPaths` — redirect recurring agent behavior

The primary use case is **redirecting an agent away from a stale or unwanted path**. An agent may reach for a data directory it remembers from training data; if that path is wrong, it can escalate into a broad disk search. Listing the old path in `deniedPaths` with the preferred location as the reason corrects the behavior immediately:

```json
{
  "deniedPaths": [
    { "paths": ["~/.config/some-app"], "reason": "moved to ~/MyData/some-app; use the new location" }
  ]
}
```

The agent touches `~/.config/some-app`, gets blocked, and the reason (surfaced as a "user note") tells it exactly where to look instead — no more disk-wide scavenger hunts.

The reason is delivered to the agent wrapped as a "user note" (`Blocked by access-denied (user note: "...")`) and is **identical whether the deny came from config or a runtime panel decision** — the agent only ever sees "the user declined this", never which layer produced it.

## Built-in safe paths (never prompt)

The guard is intended to correct persistent or overly broad filesystem behavior, not to interfere with ordinary task-scoped scratch work. OS-reclaimed temporary locations are therefore allowed by default:

- **Pseudo-devices**: `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/zero`, `/dev/urandom`, `/dev/random`, `/dev/fd/` (the process's own file descriptors). On Windows, the native device names `NUL`/`CON`/`AUX`/`PRN`/`COM1-9`/`LPT1-9` are also recognized (matched by basename, so `C:\proj\NUL`, bare `NUL`, and `NUL.txt` all work).
- **Scratch dirs**: `/tmp` (system shared, auto-cleaned) and `os.tmpdir()` (per-user temp; on Linux these are the same place). macOS `/tmp` -> `/private/tmp` symlink is handled. On Git Bash for Windows, `/tmp` maps to `%TEMP%` — see [Cross-platform behavior](#cross-platform-behavior).

Deliberately **not** allowed: `/dev/tty` (can capture keyboard input), `/dev/disk*` (block devices), and anything that persists — home dir, `/etc`, `/var`, `/usr`, etc.

Use `allowedPaths` to add your own always-safe roots (e.g. a log dir you always read).

## Commands

```
/access-denied prompt        # switch to prompt mode
/access-denied deny          # switch to deny mode
/access-denied allow         # switch to allow mode
/access-denied:status        # show status (mode, allow/deny rules, session memory)
/access-denied:reset         # clear session always-allow / always-deny memory
```

## Path resolution

**In-bounds** = current project `cwd` + configured `allowedPaths` + built-in safe paths. A target path is `resolve`d + `normalize`d and run through the PathManager (longest-prefix-match across all rule layers — see [Rule resolution](#rule-resolution-longest-prefix-match)). A matching allow rule passes it; a matching deny rule blocks it; an uncovered path triggers authorization.

- **`write` / `edit`**: takes the `path` argument directly — exact.
- **`bash`**: the command string is parsed into a structural AST ([unbash](https://github.com/webpro-nl/unbash)) and walked recursively; only **clearly escaping** tokens are judged:
  - absolute paths starting with `/`
  - `~` / `$HOME` prefixes (current user's home)
  - `~otheruser` prefixes (another user's home — kept symbolic, see below)
  - `..` parent climbs (`../x`, `a/..`, `a/../b`)

  Relative paths under `cwd` (e.g. `src/foo.ts`, `cat README.md`) are left alone by default.

`~otheruser` (another user's home, e.g. `~root`) is recognized too. Its real target can't be resolved without the user database, so it's kept as a symbolic form — a config rule `~otheruser/x` and a command `~otheruser/x/y` normalize to the same symbol and match by prefix. Put one in `allowedPaths`/`deniedPaths` to allow or redirect it. `~` (current user) still expands to the real home.

**Quoted strings are data, not paths.** A quoted run (single/double/ANSI-C) is an argument's value — e.g. a multi-line `git commit -m "…"` message. Static analysis cannot tell whether a quoted run is a path a program will open or merely a value that happens to contain path-like text, so its inner text is never mined for path tokens. This keeps the gate quiet — without it, every `/…` inside a commit message would be a false positive, and a flood of those would train you to blanket-allow everything, disarming the gate exactly when a real `rm -r /` later appears. Command and process substitutions still execute inside quotes (`"$(rm /x)"`), so they are recursed into regardless of quoting context. Heredoc bodies are stdin data and not scanned; an *unquoted* heredoc's `$(…)` substitutions do execute and are caught.

**Backslash escapes are resolved by the parser.** `/a/Agent\ Workspace/b` is one token whose dequoted value is `/a/Agent Workspace/b`. This covers `\ `, `\;`, `\(`, `\|`, `\\`, etc.

Note: read-only commands that traverse outside `cwd` (like `find /`, `ls /etc`) are also gated — bash access outside the project is blocked regardless of read/write, by design.

## Cross-platform behavior

pi runs commands through **Git Bash** on Windows, so bash command strings arrive in MSYS style (`/dev/null`, `/tmp`, `/c/Users/...`). Node's `path` module does not understand MSYS path conventions — `path.win32.normalize("/dev/null")` yields `\dev\null`, which would otherwise fail to match the Unix-style safe-path constants. The gate handles MSYS paths itself instead of relying on Node:

1. **Safe-path constants work on both platforms.** `/dev/null`, `/dev/std*`, `/dev/fd/`, and `/tmp` are matched after normalizing separators to `/`, so the `\dev\null` produced by Windows path resolution is recognized as the same safe path as the POSIX `/dev/null`.

2. **MSYS drive notation.** `/c/Users/me` is resolved to `C:\Users\me` before allowlist checks (case-insensitive, as MSYS is). So a command writing under cwd in MSYS style (`/c/proj/src/...`) is correctly seen as in-bounds rather than mis-resolved to `C:\c\proj\...`.

3. **`/tmp` on Git Bash for Windows** maps to `%TEMP%` (the OS-reclaimed per-user temp) by default, matching the Unix `/tmp` semantics, and is treated as safe. *(If you reconfigured `/etc/fstab` to mount `/tmp` at a permanent location, that location is still treated as safe — extremely rare configuration, and the blast radius is limited to `/tmp` writes.)*

**Cannot be resolved statically** (treated as out-of-bounds, conservatively): MSYS paths whose real Windows target depends on the install location or mount table — `/usr/...`, `/etc/...`, the MSYS root `/`. If your workflow needs these, add them to `allowedPaths` with their real Windows paths.

## Limitations (bash heuristic)

A bash command is an arbitrary shell string, so **perfect static path analysis is impossible**. The structural parse recurses into command substitutions `$(…)`, process substitutions `<(…)`, subshells, pipelines, and every control-flow body (`if`/`for`/`while`/`case`/…), but these blind spots remain:

- **Unexpanded `$VAR`** (other than `$HOME`/`${HOME}`) can't be analyzed statically and is skipped (allowed). e.g. `cat $SECRET_FILE`.
- **Quoted real paths are treated as data.** `cat '/etc/passwd'` passes through even though `cat /etc/passwd` (bare) is blocked — a quoted run is an argument value, and static analysis cannot know whether a given program opens it as a file. The bare-path check covers the common case.
- An assignment like `X=/etc/passwd` is data, not file access, and is skipped (nested `X=$(…)` still recurses).

This matching is best-effort, not an absolute sandbox: static analysis cannot resolve every shell expansion, so it favors low noise over completeness. The goal is to correct common agent behavior with little noise, not to understand every possible shell expansion. For enforced isolation, use a container or remote execution boundary.

## Non-TUI sessions (RPC / ACP)

The authorization panel is built on pi's TUI-only `ctx.ui.custom()` API. In RPC/ACP sessions (e.g. via `pi-acp` in Zed) the gate falls back to one `ctx.ui.select()` dialog per out-of-bounds path, offering the same four actions (Allow / Always allow / Deny / Always deny). The answers flow through pi's extension UI sub-protocol and are answered by the host adapter; "always" choices are remembered for the session exactly like panel decisions.

Known gaps versus the TUI panel: there is no global deny-reason input, so a deny always carries the default `Blocked by access-denied` message — ACP has no text-input request primitive (not an adapter gap), so the reason note cannot be carried. Dismissing any dialog cancels the whole authorization — a soft deny. In print/JSON mode no host answers dialogs at all, so out-of-bounds calls resolve as `Authorization dismissed`. Set `mode` to `allow` when running non-interactively and this behavior guard is not wanted.

## Design notes

- **Session state** is stored on `globalThis` (per the monorepo convention, avoiding module-identity issues from pi's absolute-path loading); reset to the configured default on `session_start`.
- **One decision engine.** All access checks flow through a single `PathManager` (longest-prefix-match) rather than a chain of scattered predicates. Rule layers (builtin / config / session) are equal peers at decision time; layering is only used to group the `/access-denied status` output.
- **Deny reasons speak with the user's voice.** Whether a deny came from config `deniedPaths` or a runtime panel decision, the agent receives the same `Blocked by access-denied (user note: "...")` form — it never learns which layer blocked it.
- **Session memory is never persisted** — by design; restarting forgets, preventing authorization drift into hidden risk. Config rules (`allowedPaths` / `deniedPaths`) reload from settings on each session.
- Interception uses pi's `tool_call` event, returning `{ block: true, reason }`; the deny reason is passed back to the LLM as the block reason.
