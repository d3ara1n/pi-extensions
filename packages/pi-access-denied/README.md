# pi-access-denied

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-access-denied)](https://www.npmjs.com/package/@d3ara1n/pi-access-denied) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-access-denied)](https://www.npmjs.com/package/@d3ara1n/pi-access-denied) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-access-denied)](https://www.npmjs.com/package/@d3ara1n/pi-access-denied)

Keep pi focused on your project. Review detected access to outside paths, remember locations you trust, and give the agent a reason when you block a path.

For example, you can catch a broad `find /`, allow a shared notes folder, or tell the agent where an old data directory moved. The extension checks `write`, `edit`, and common path expressions in `bash` commands.

Bash checks are best-effort. This is a behavior guard, not a security sandbox; use OS or container isolation when you need enforced filesystem boundaries.

## Installation

```bash
pi install npm:@d3ara1n/pi-access-denied
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-access-denied"
  ]
}
```

Run `/reload` or restart pi after installation.

## Dependencies

None.

## Choose how outside paths are handled

The default mode is `prompt`. Your project directory and temporary locations are allowed by default; other detected paths need your decision.

| Mode | When a detected path has no matching rule |
|------|------------------------------------------|
| `prompt` | Ask you before the tool call runs |
| `deny` | Block the tool call without asking |
| `allow` | Let the tool call run without asking |

Explicit deny rules still apply in every mode, including `allow`.

```text
/access-denied prompt        # Ask about outside paths
/access-denied deny          # Block outside paths
/access-denied allow         # Allow outside paths without asking
/access-denied:status        # Show the current mode and path rules
/access-denied:reset         # Forget decisions remembered for this session
```

### Review a request

The terminal panel shows each path that needs a decision and the command that uses it.

Bash paths are possible accesses detected before execution. When a path depends on a tracked `cd` outcome, an indented, dim line below `source` explains it, such as ``if `cd src` fails``. Conditions shared by all detected routes to that path are shown; the line is omitted when none are known.

Choose an action for each path:

| Action | Effect |
|--------|--------|
| **Allow** | Approve this call; the default selection |
| **Always allow** | Allow this path and everything beneath it for this session |
| **Deny** | Block this call |
| **Always deny** | Block this path and everything beneath it for this session |

**Denying any path blocks the entire tool call.** The extension does not run the approved pieces of a compound bash command separately. Any “always” choices you submitted are still remembered.

When you deny a request, you can add a reason for the agent, such as “Use the export in the project instead.” The same reason applies to all denied paths in that request.

Use `↑` / `↓` to select a path, `←` / `→` or `Tab` to change its action, and `Enter` to submit. `Esc` cancels the request; in the reason field, it returns to the path list.

Remembered decisions clear on restart, `/reload`, `/new`, or `/resume`. Add lasting rules to your settings.

## Save path rules

Add an `accessDenied` block to `~/.pi/agent/settings.json`, or to `.pi/settings.json` for one project:

```json
{
  "accessDenied": {
    "mode": "prompt",
    "allowedPaths": ["~/Documents/notes"],
    "deniedPaths": [
      {
        "paths": ["~/.config/old-app/data"],
        "reason": "Data moved to ~/Documents/exports; use that folder instead"
      },
      { "paths": ["/old/cache"] }
    ],
    "tools": ["write", "edit", "bash"]
  }
}
```

- `allowedPaths` lets you work in additional locations without repeated prompts.
- `deniedPaths` blocks detected access to listed locations. An optional `reason` tells the agent what to do instead.
- `tools` selects which supported tools to check. The default is `write`, `edit`, and `bash`.
- `mode` sets the starting mode. The default is `prompt`.

A project's `accessDenied` block replaces the global block as a whole. Omitted fields use defaults, so include any global rules you also want in that project. Reload pi after changing settings.

### When rules overlap

The rule for the most specific folder wins. For example, allowing `/data` and denying `/data/private` lets the agent use `/data/reports` while blocking `/data/private`.

This applies equally to default paths, settings, and remembered decisions. A more specific allow can override a broader deny. If allow and deny name the same path, deny wins.

### Locations allowed by default

The extension allows your project directory, the system temporary directory, `/tmp`, and common process I/O paths such as `/dev/null`, `/dev/stdout`, and `/dev/fd/`. It also recognizes macOS's `/private/tmp` and Windows device names such as `NUL`.

Your home directory, `/etc`, `/var`, and `/usr` are not generally allowed. Add any locations you need to `allowedPaths`. You can also override a default allow with a more specific deny rule.

## What bash checks cover

Commands such as `find /`, `cat /etc/config`, `rm ~/old-cache`, and `cat ../notes.txt` are checked. This includes read-only commands: the check concerns the location, not whether a command writes data.

The extension recognizes absolute paths, `~` and `$HOME` prefixes, and parent-directory references such as `../file` or `a/../b`. It also checks commands nested inside substitutions, pipelines, and shell groups. Ordinary relative arguments such as `src/app.ts` and `README.md` are generally left alone.

References to another user's home, such as `~otheruser`, are kept in that form. You can use the same form in `allowedPaths` or `deniedPaths`.

Quoted literal arguments are treated as data, so a path mentioned in a commit message does not trigger a prompt. Known variable references such as `"$file"` are checked after expansion. `cd` also checks quoted literal destinations such as `cd "shared files"`. Substitutions inside quotes still have their commands checked, as in `echo "$(cat /etc/config)"`.

### Commands that change directory

You can use `cd` before another command. Recognized relative paths are resolved from the directory that command would use, while your project's allowed boundary stays the same.

For an initial directory of `/project`:

| Command | Location checked for `../bbb` |
|---------|------------------------------|
| `cd aaa && cat ../bbb` | `/project/bbb` |
| `cd aaa; cat ../bbb` | `/project/bbb` if cd succeeds; `/bbb` if it fails |
| `cd aaa \|\| cat ../bbb` | `/bbb`, because cat runs only if cd fails |
| `cd aaa & cat ../bbb` | `/bbb`, because the background cd does not change cat's directory |

**Use `&&` when the next command should run only after a successful `cd`.** A semicolon or newline still runs the next command if `cd` fails, so both possible paths may need authorization. The extension does not execute `cd` or check that its destination exists before making this decision.

Consecutive directory changes, quoted paths, `cd --`, `cd -L`, home-directory forms, and `cd -` are supported. `cd -` needs a previous directory established within the same call. Directory changes inside parentheses, substitutions, pipelines, or background commands stay local to those commands; `{ ...; }` groups share their shell's directory.

### Variables assigned within a command

Plain scalar assignments are followed within one bash tool call. `$name`, `${name}`, and double-quoted references can supply path candidates:

```bash
f=../private/data && rm "$f"
base=../private; f="$base/data"; cat "${f}.bak"
dir=shared; cd "$dir" && cat ../notes.txt
```

Assignment values are data; the check happens when a command uses the value. Relative values are resolved from that command's directory. `rm f` uses the literal filename `f`, not the variable. Ordinary relative values such as `src/app.ts` remain subject to the same rules as literal arguments.

Branches carry their own values and directories. Subshells, substitutions, pipelines, and background commands do not change the parent's variables; brace groups do. Values do not persist across tool calls. A temporary assignment in `f=../new rm "$f"` does not change the value expanded for that command's argument.

### Limits to keep in mind

Some paths cannot be determined from the command text:

- **Dynamic paths:** variables without known values, command-output values, arrays, append assignments, and complex parameter expansions remain unresolved. Unquoted values requiring word splitting or glob expansion are skipped. After a `cd` to an unknown destination, relative paths are skipped until a known directory is established; absolute paths remain checked.
- **Variable mutations:** builtins such as `read`, `unset`, `export`, and `declare`, arithmetic, and loop-variable assignments can invalidate tracked values. These operations are not interpreted as general shell code. Variable attributes, custom shell setup, and repeated loop iterations can limit analysis.
- **Quoted file arguments:** `cat '/etc/config'` is skipped, even though the unquoted form is checked. Known variable references and `cd` destinations are exceptions.
- **Scripts and shell setup:** evaluated code, function calls, directory-stack commands, repeated directory changes in loops, aliases, and shell options can limit what is detected. Symlinks are not resolved.

Assignments to `HOME`, `PWD`, and `OLDPWD` also affect directory tracking. A nonempty `CDPATH` makes directory lookup uncertain; use an explicit `./`, `../`, or absolute destination when you want a predictable path check.

These limits favor fewer interruptions during ordinary work. Approval is not a guarantee that every path a script might access has been checked.

## Windows

Pi uses Git Bash on Windows. The extension recognizes both native drive paths (`C:\Users\me`) and Git Bash drive paths (`/c/Users/me`), and treats `/tmp` as temporary storage. Paths such as `/usr` and `/etc` depend on your Git Bash installation and may still need authorization.

## Editors and non-interactive sessions

In RPC/ACP hosts, such as an editor connected through pi-acp, requests appear as a separate choice dialog for each path. The same four actions are available. Custom denial reasons are available only in the terminal panel; dismissing a dialog blocks the call.

In print/JSON mode there is no interactive response, so requests in `prompt` mode are blocked as dismissed. Set `mode` to `deny` to block outside paths without interaction, or `allow` to let them through. Explicit deny rules still apply.
