# pi-access-denied

Sandbox `write` / `edit` / `bash` to the project directory — any access outside an allowlist requires your authorization first.

## Why

By default, pi's `write` / `edit` / `bash` can read and write any file the agent process has permission to. This extension adds an access boundary: **outside the project directory = needs authorization**.

> About pi's built-in "trusted projects": that controls *whether to load a project's local config / resources / extensions* (defense against malicious `.pi/settings.json` executing code) — its semantics is code-execution trust. What this extension does is *restrict the file-access range of agent tools*. The two are orthogonal, so it does **not** reuse pi's trust store; it only borrows the `ask / always / never` UX pattern.

## Three modes

| Mode | Behavior |
|------|----------|
| `prompt` | Ask the user on each out-of-bounds access (default) |
| `deny`  | Block every out-of-bounds access without asking |
| `allow` | Passthrough (effectively disable the gate) |

Authorization panel (`prompt` mode only):

When a tool reaches outside the allowlist, a bottom-anchored panel lists every out-of-bounds path on its own row, each defaulting to **Accept**. A single horizontal action bar reflects the *focused* path's current choice:

- **Accept** (default) — allow this one call; shows no marker on its row
- **Always accept** — remember the path **and everything beneath it**, don't ask again this session; marks the row `[always-accept]` (green)
- **Deny** — block this one call; marks the row `[deny]` (red)
- **Always deny** — permanently block that path **and everything beneath it** this session; marks the row `[always-deny]` (red)

Each path keeps its own choice, so a multi-path `bash` call can accept some paths while denying others in a single pass. Submitting with any deny present pops a **single global reason** input (leave empty for a default reason); **Esc there returns to the path list** rather than committing a no-reason deny.

Keys: `↑`/`↓` move path focus · `←`/`→` change the focused path's action (no wrap) · `Tab` cycles the action (wraps) · `Enter` submit · `Esc` cancel the whole authorization (or, in the reason input, go back to the path list).

"Always" memory uses **prefix coverage** (not exact paths): authorizing `/a/b` also covers `/a/b/c`, `/a/b/c/d`, … so you never get re-prompted for a path whose ancestor you already decided on. When you remember a **broader** path, any narrower entries it now subsumes are dropped, keeping the list minimal and the status view free of "parent listed next to its own child" oddity. Memory is **session-only** — restarting pi, `/reload`, `/new`, `/resume` all clear it.

## Install

Add the package path to the `extensions` array in `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-access-denied"
  ]
}
```

Then `/reload` (or restart pi). The status bar will show something like `🔐 access:prompt`.

## Configuration

Under the `accessDenied` key in `settings.json` (global `~/.pi/agent/settings.json` or per-project `.pi/settings.json`; project overrides global):

```jsonc
{
  "accessDenied": {
    "mode": "prompt",                    // prompt | deny | allow, default prompt
    "extraAllowedDirs": [                // extra full read/write roots (~ and $HOME allowed)
      "~/Documents/notes",
      "/tmp/build-out"
    ],
    "extraSafePaths": [],                 // finer-grained paths that never prompt
    "tools": ["write", "edit", "bash"]   // which tools to gate, default these three
  }
}
```

## Built-in safe paths (never prompt)

The gate's purpose is to stop an out-of-control agent from leaving **permanent footprints** outside the project (configs, user data, system files) — not to isolate users or hide other programs' data. So task-scoped scratch space that the OS reclaims is always allowed:

- **Pseudo-devices**: `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/zero`, `/dev/urandom`, `/dev/random`, `/dev/fd/` (the process's own file descriptors). On Windows, the native device names `NUL`/`CON`/`AUX`/`PRN`/`COM1-9`/`LPT1-9` are also recognized (matched by basename, so `C:\proj\NUL`, bare `NUL`, and `NUL.txt` all work).
- **Scratch dirs**: `/tmp` (system shared, auto-cleaned) and `os.tmpdir()` (per-user temp; on Linux these are the same place). macOS `/tmp` -> `/private/tmp` symlink is handled. On Git Bash for Windows, `/tmp` maps to `%TEMP%` — see [Cross-platform behavior](#cross-platform-behavior).

Deliberately **not** allowed: `/dev/tty` (can capture keyboard input), `/dev/disk*` (block devices), and anything that persists — home dir, `/etc`, `/var`, `/usr`, etc.

Use `extraSafePaths` to add your own safe paths (e.g. a log dir you always read).

## Command

```
/access-denied              # show status (mode, allowlist, session memory)
/access-denied prompt       # switch to prompt mode
/access-denied deny         # switch to deny mode
/access-denied allow        # switch to allow mode
/access-denied reset        # clear session always-allow / always-deny memory
```

## Path resolution

**Allowlist** = current project `cwd` + configured `extraAllowedDirs`.
A target path is `resolve`d + `normalize`d; if it falls inside any allowed dir (including the dir itself) it passes, otherwise it triggers authorization.

- **`write` / `edit`**: takes the `path` argument directly — exact.
- **`bash`**: heuristic token scan of the command string; only **clearly escaping** tokens are judged:
  - absolute paths starting with `/`
  - `~` / `$HOME` prefixes
  - `..` parent climbs (`../x`, `a/..`, `a/../b`)

  Relative paths under `cwd` (e.g. `src/foo.ts`, `cat README.md`) are left alone by default.

**Quoted strings and heredoc bodies are treated as data, not paths.** A quoted run (`echo '...'`, `sed 's|a|b|g'`, `printf '%s' ...`) is a literal passed to a program, so it's skipped entirely — this is what stops a JS block comment like `'/* header */ code'` at the start of a quoted string from being mistaken for absolute path `/`. Likewise, a `<<DELIM ... DELIM` heredoc body is stdin data, so every `/...` token inside embedded code is ignored. Only the opener line (e.g. `cat /etc/passwd <<EOF`) is still scanned.

**Backslash escapes are honored inside unquoted tokens.** `Agent\ Workspace` is one token (a path containing a literal space), not two — the `\` + next char is kept together and the backslash stripped, so `/a/Agent\ Workspace/b` is treated as `/a/Agent Workspace/b`. This covers `\ ` (space), `\;`, `\(`, `\|`, even `\\` → `\`. It applies only to **unquoted** tokens; inside quotes the backslash is left untouched (quotes already protect the content).

Note: read-only commands that traverse outside `cwd` (like `find /`, `ls /etc`) are also gated — bash access outside the project is blocked regardless of read/write, by design.

## Cross-platform behavior

pi runs commands through **Git Bash** on Windows, so bash command strings arrive in MSYS style (`/dev/null`, `/tmp`, `/c/Users/...`). Node's `path` module does not understand MSYS path conventions — `path.win32.normalize("/dev/null")` yields `\dev\null`, which would otherwise fail to match the Unix-style safe-path constants. The gate handles MSYS paths itself instead of relying on Node:

1. **Safe-path constants work on both platforms.** `/dev/null`, `/dev/std*`, `/dev/fd/`, and `/tmp` are matched after normalizing separators to `/`, so the `\dev\null` produced by Windows path resolution is recognized as the same safe path as the POSIX `/dev/null`.

2. **MSYS drive notation.** `/c/Users/me` is resolved to `C:\Users\me` before allowlist checks (case-insensitive, as MSYS is). So a command writing under cwd in MSYS style (`/c/proj/src/...`) is correctly seen as in-bounds rather than mis-resolved to `C:\c\proj\...`.

3. **`/tmp` on Git Bash for Windows** maps to `%TEMP%` (the OS-reclaimed per-user temp) by default, matching the Unix `/tmp` semantics, and is treated as safe. *(If you reconfigured `/etc/fstab` to mount `/tmp` at a permanent location, that location is still treated as safe — extremely rare configuration, and the blast radius is limited to `/tmp` writes.)*

**Cannot be resolved statically** (treated as out-of-bounds, conservatively): MSYS paths whose real Windows target depends on the install location or mount table — `/usr/...`, `/etc/...`, the MSYS root `/`. If your workflow needs these, add them to `extraAllowedDirs` with their real Windows paths.

## Limitations (bash heuristic)

A bash command is an arbitrary shell string, so **perfect static path analysis is impossible**. Known blind spots:

- **Unexpanded `$VAR`** (other than `$HOME`) can't be analyzed statically and is skipped (allowed). e.g. `cat $SECRET_FILE`.
- **Paths produced by command substitution / pipelines** are invisible, e.g. `cat $(somecmd)`, `echo {a,b}` brace expansion.
- An assignment like `X=/etc/passwd` generally triggers no real access and is skipped.
- **Quoted real paths are no longer caught** as a side effect of treating quoted runs as data: `cat '/etc/passwd'` passes through even though `cat /etc/passwd` (bare) is blocked. The bare-path check still covers the common case; this only loosens quoted-path arguments.
- Complex quoting can in theory cause misjudgment. Plain backslash escapes in unquoted tokens are handled (see Path resolution), but nested/layered quoting (`"'$x'"`) is not.

This is a **protection layer**, not an **absolute sandbox** — it blocks the vast majority of straightforward out-of-bounds access (`cat /etc/passwd`, `rm ~/notes`, `echo x > /etc/foo`) but not deliberate evasion. For strong isolation, combine with pi's containerization / SSH remote execution.

## Non-interactive mode

In `-p` (print), `--mode json`, `--mode rpc` without a UI, `prompt` mode can't show a dialog, so it **fails safe**: out-of-bounds access is blocked (reason: `no UI to authorize`). To allow access in those modes, set `mode` to `allow`.

## Design notes

- **Session state** is stored on `globalThis` (per the monorepo convention, avoiding module-identity issues from pi's absolute-path loading); reset to the configured default on `session_start`.
- **Authorization memory is never persisted** — by design; restarting forgets, preventing authorization drift into hidden risk.
- Interception uses pi's `tool_call` event, returning `{ block: true, reason }`; the deny reason is passed back to the LLM as the block reason.
