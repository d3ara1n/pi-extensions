# @d3ara1n/pi-subagent

Role-based subagent orchestration for [pi](https://github.com/earendil-works/pi).

Provides a `subagent_delegate` tool that lets the main model offload tasks to specialized pi child processes with configurable model roles, real-time TUI progress, and AI-generated summaries. Runs can be foreground (blocking) or background (asynchronous, collected later via `subagent_wait`/`subagent_check`, cancellable via `subagent_cancel`). A centered live view (`/subagent:view`) shows every run's activity feed as it happens, with a per-run brief page for inputs and stats; mid-run corrections can be queued into a running subagent from the view's steer editor or via `subagent_steer`.

## Design Philosophy

**The main model is the decision maker; subagents are executors.**

Your primary AI has the most complete context — it knows the full conversation history, project structure, and task at hand. Subagents are isolated by default to handle specific, well-defined tasks without polluting the main model's context window. A caller can explicitly opt into a filtered, text-only snapshot of the active parent branch when a task genuinely depends on prior dialogue.

This means:
- **Subagents don't plan** — the main model decides what needs to be done and provides a clear task description
- **Subagents don't orchestrate the overall plan** — the main model decides what to do and examines each result to pick the next move; nested delegation (worker → explorer) only offloads self-contained exploration/research inside one task
- **Subagents are isolated by default** — give them a precise, self-contained task; use `inheritConversation` only when prior dialogue is necessary
- **Multiple subagents can run in parallel** — emit multiple `subagent_delegate` calls in one turn; pi executes them concurrently
- **Subagents can nest subagents** — a `worker` can delegate exploration to `explorer` without returning to the main model

> This design currently focuses on single-task delegation rather than chain pipelines or context-forking — those patterns fit better when subagents act as advisors (planner, oracle) rather than executors.

## Model Compatibility

Observations on how main models behave with this plugin, one family per subsection. Subagent role models are configured separately via [pi-model-roles](../pi-model-roles); the notes below concern the **main model** — the orchestrator that decides when to delegate.

### GPT family

**Not recommended.** As of GPT 5.6, GPT models delegate pathologically: they abandon built-in tools (`read`, `edit`, `write`) and MCP entirely and route everything through subagents — `explorer` to read files, `worker` to modify them, `reviewer` to verify each change, then worker → reviewer → worker correction loops over and over. Every task a direct handful of tool calls would finish turns into a long delegate chain, wasting large amounts of time and tokens. Use a main model that treats direct tool calls as the default and delegation as the exception.

## How it works

1. Main model calls the `subagent_delegate` tool with a role and task description
2. The extension resolves the role to a model via pi-model-roles
3. Spawns a pi child process in RPC mode (`--mode rpc`, always without a reused parent session) with the configured model, tools, and system prompt. It is isolated by default; `inheritConversation: true` adds a filtered parent-branch snapshot to its initial stdin prompt. Agent events stream back over stdout while stdin carries the initial prompt and mid-run steering commands. Children are headless: interactive extension dialogs (`ctx.ui.select/confirm/input`) are answered automatically with `cancelled` (standard "user declined" semantics), so an extension that asks never hangs the run
4. **Real-time TUI progress** shows tool calls, turns, and elapsed time as the subagent runs
5. After completion, an **AI-generated one-line summary** is produced for compact display
6. Returns the result to the main model with usage statistics (turns, tokens, cost)

## Built-in Roles

| Role | Model Role | Timeout | Tools | Can Delegate To | Description |
|------|-----------|---------|-------|-----------------|-------------|
| `explorer` | fast | 900s | read, find, grep, bash | — | Fast code exploration incl. git history inspection (read-only) |
| `reviewer` | heavy | 3600s | read, bash, grep, find, subagent_delegate | explorer, researcher | Deep code review, runs git/tests for evidence (read-only); delegates exploration & web verification |
| `worker` | default | 2400s | all (no whitelist) | explorer, researcher | Implementation — the only role that can modify files; full tool access (web, MCP, everything) |
| `researcher` | fast | 2400s | web_search, fetch_content, source_check, get_search_content, read, bash, edit, write, subagent_delegate | explorer | Web research + GitHub repo analysis; writes artifacts only inside its temp dir |

**Web tool naming**: `researcher`'s web tools use the community-standard names (`web_search`, `fetch_content`, `source_check`, `get_search_content`) shared by the most popular Pi web extensions — [pi-web-access](https://github.com/nicobailon/pi-web-access), `pi-web-tools`, `pi-browse`, and others. Install any of those and the researcher gets web access out of the box. If your web extension uses different tool names (e.g. `websearch`/`webfetch`) or you renamed the tools via a `toolNames` config, override `researcher.tools` in `agentOverrides` to match.

**Nested delegation**: `worker`, `reviewer`, and `researcher` can spawn their own subagents. This keeps the caller's context clean — a worker can explore unfamiliar code via an `explorer` subagent without returning intermediate results, and a reviewer can verify third-party library behavior via a `researcher` subagent without leaving the diff.

**Parallel execution**: To run multiple subagents concurrently, emit multiple `subagent_delegate` calls in a single turn. Pi's framework executes them in parallel automatically, with each subagent getting its own TUI progress display.

## TUI Display

- **During execution**: the task's first line with a ⏳ (or ⏸ queued) indicator, a live stream of thinking blocks and tool calls (latest 5 collapsed, everything expanded), and a usage line (elapsed/budget time, turns, tokens, peak context, cost, model). Delegates using inherited conversation are marked in the tool-call title.
- **Collapsed result**: the task's first line, then `✓` + the AI-generated summary (or the first line of the output), then the usage line — no activity replay
- **Expanded result** (Ctrl+O): reference files, context size, the full task, the complete activity stream, the final output as rendered Markdown, and usage details
- **Fallback trace**: when a provider error (429, quota, timeout, ...) kills a run and it is retried on the role's `fallbackRole`, a `⚠ fallback: first attempt <model> failed (<reason>)` line appears in both views — also while the retry is running (see [Fallback observability](#fallback-observability))

## Commands

| Command | Description |
|---------|-------------|
| `/subagent:view` | Open the live view: a tabbed overlay with a per-run activity feed and a brief detail page (inputs, files, stats), plus modal steer input for the focused run |
| `/subagent:doctor` | Diagnose pi invocation, model-role resolution, configuration, and role references |
| `/subagent:status` | List background runs and their current state |
| `/subagent:cancel <id\|all> [reason]` | Cancel a live background run (or every live run); the optional reason is recorded with the run |

### Live view (`/subagent:view`)

A centered overlay covering most of the screen. A tab row across the top lists every run (icon · id · role); `Tab` cycles the focused run, and the rest of the viewport belongs to it alone — showing one of two pages, toggled with `d`.

The **activity page** (default) is the run's live feed: a continuous, append-only list where each entry is static text with a state icon, and the only animated thing is the ellipsis on a running entry (`.` → `..` → `...`). Finishing freezes an entry in place — its position never changes, only the icon flips. Streamed assistant text grows in place as the run's last line and settles into plain terminal-colored text at the turn boundary. The feed is scrollable (`↑↓`, `PgUp/PgDn`, `Home`/`End`): the view pins to the end and auto-follows new entries; scrolling up unpins (a `⋮ N earlier` marker appears), and reaching the bottom again re-pins. Both foreground and background runs appear here; a foreground run stays listed while its delegate call blocks the main agent. A run leaves the view once its result is in the conversation — when the last one goes, the overlay shows a centered empty notice (with `Esc close` hinted) rather than shrinking away.

The **brief page** shows the run's inputs and vitals at full width: the task and context verbatim (wrapped; head+tail elided beyond 20k chars), inherited-conversation size and truncation status when enabled (never its text), the reference file list annotated with `✓`/`·` for whether the child's tool calls actually touched each file, usage and time stats, the fallback trace, and a stderr tail on failures.

Steer input is modal so keys never conflict with typing: in browse mode `s` opens the editor, `Enter` queues the message into the focused run (only while it is running) and returns to browse, `Esc` cancels and clears. The message appears immediately in the feed as an `↩ steer:` entry and is delivered to the child after its current tool batch, before its next LLM call — the run keeps its progress. `Esc` in browse mode closes the overlay.

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — model role resolution

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-subagent
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-subagent"
  ]
}
```

## Configuration

Edit `~/.pi/agent/settings.json`:

```json
{
  "subagent": {
    "maxConcurrency": 4,
    "maxDepth": 3,
    "maxTurns": 0,
    "maxCost": 0,
    "history": {
      "enabled": true
    },
    "summary": {
      "role": "utility",
      "enabled": true
    },
    "inheritance": {
      "maxChars": 50000
    }
  }
}
```

All fields are optional. Defaults: `maxConcurrency: 4`, `maxDepth: 3`, `maxTurns: 0` (unlimited), `maxCost: 0` (unlimited), `history.enabled: true`, `summary.role: "utility"`, `summary.enabled: true`, and `inheritance.maxChars: 50000`.

Timeouts are defined per role. Built-in defaults are `explorer: 900`, `reviewer: 3600`, `worker: 2400`, and `researcher: 2400` seconds. The timeout is active time — the clock pauses while the child is inside a nested `subagent_delegate` call, so delegate-capable roles need no extra headroom.

`maxConcurrency`, `maxDepth`, `maxTurns`, `maxCost`, and per-role `timeout` accept `0` for unlimited. Negative values are normalized to `0`; non-numeric or non-finite values fall back to their defaults. `inheritance.maxChars` is different: it must be a positive finite integer, and zero, negative, invalid, or non-finite values use the default. `maxConcurrency: 0` runs delegates without queuing, and `maxDepth: 0` permits unrestricted nesting.

### Agent Overrides

Override, disable, or add subagent roles via `agentOverrides`. Built-in and custom roles are treated equally — all descriptions, examples, and decision triggers feed into the LLM's prompt dynamically.

```json
{
  "subagent": {
    "agentOverrides": {
      "worker": {
        "role": "heavy",
        "timeout": 1500,
        "maxTurns": 50,
        "maxCost": 1.0
      },
      "reviewer": {
        "disabled": true
      },
      "tester": {
        "role": "default",
        "description": "Test automation & QA — write and run tests, validate fixes. Can delegate to explorer.",
        "examples": [
          "Write unit tests for the auth module",
          "Run the test suite and fix failing tests"
        ],
        "decisionTrigger": "Task writes or runs tests?",
        "tools": ["read", "bash", "edit", "write", "grep"],
        "systemPrompt": "QA engineer. Write tests, run them, fix failures. After each change, re-run affected tests."
      }
    }
  }
}
```

**Required fields for custom roles:** `role`, `description`, `examples`, `decisionTrigger`, `systemPrompt`.

**Tool policy (optional, pick exactly one):**

- `tools` — exact-name allowlist: absent means all tools, a list restricts to exactly those tool names, an **empty array means zero tools**.
- `excludeTools` — denylist: everything except the listed tool names (handy for e.g. withholding interactive tools from an otherwise full-access role). Absent or empty means no restriction.

Configuring both on the same role is an error — the role is skipped with an error notification at session start.

**Optional fields:** `subagentRoles` (roles this role can spawn via delegate; absent means any available role, mirroring the `tools` default — declare it explicitly when a restricted role grants `subagent_delegate`), `timeout` (per-role active-time timeout in seconds; unset or `0` is unlimited, negative values normalize to `0`), `maxTurns` / `maxCost` (per-role budget overrides; unset uses the top-level `maxTurns` / `maxCost` setting, `0` is unlimited, negative values normalize to `0`), `fallbackRole` (backup pi-model-roles role the whole run is retried on after a provider error; unset means no retry — see [Fallback observability](#fallback-observability)).

Invalid custom roles (missing required fields) are skipped with an error notification at session start.

## Usage (by the main model)

Delegate tasks that would generate many tool calls or verbose output to keep your own context clean:

```json
{
  "role": "explorer",
  "task": "Find all files that import the ModelRegistry and trace how they use it"
}
```

**Role-specific examples:**

| Role | Example task | Why delegate? |
|------|-------------|---------------|
| `explorer` | `"Map the routing structure of src/api/"` | You only need the conclusion, not every grep result |
| `reviewer` | `"Review error handling in auth.ts for security issues"` | Review output is longform; keep it isolated |
| `worker` | `"Rename all snake_case fields to camelCase in src/models/"` | Your context stays focused on high-level intent |
| `researcher` | `"Find the React 19 migration guide and summarize breaking changes"` | Search results are noisy; get a clean summary |

**Parallel usage:** emit multiple `subagent_delegate` calls in a single turn:

```json
[
  { "role": "explorer", "task": "Map the repository structure" },
  { "role": "researcher", "task": "Find latest docs on the library used here" }
]
```

### Inheriting parent conversation

`inheritConversation` is opt-in and defaults to `false`. Use it when a delta task relies on the active parent dialogue and repeating that material would be impractical:

```json
{
  "role": "worker",
  "task": "Implement the approved approach and satisfy the acceptance checklist above.",
  "inheritConversation": true
}
```

At delegate execution, pi-subagent snapshots `buildContextEntries()` for the active branch. It serializes only compaction summaries, branch summaries, and text blocks from user and assistant messages. Thinking, images, tool calls and arguments, tool results, custom UI/state messages, bash messages, and model metadata are excluded. Newer compaction entries with a `retainedTail` are supported; older `firstKeptEntryId` compactions use the separately returned kept entries.

The inherited body is mechanically limited by `inheritance.maxChars` (default 50,000). When it is too long, pi-subagent retains summary context and the newest dialogue, inserting an omission marker. No model call summarizes this input. The child receives it in an independent `<inherited_conversation>` block after `files` and before explicit `context` and `task`; the task remains authoritative. Inherited conversation can be incomplete, so the child must report missing material rather than guess.

The tool-call title marks inherited runs. Expanded delegate input and `/subagent:view`'s brief page show the delivered character count plus `truncated` when applicable, next to the other input metadata; an enabled snapshot with no eligible text is shown as empty. The inherited body is never rendered or written to subagent history. History records only the safe inheritance flag, character count, and truncation status.

Keep the default isolated mode for focused work. Without inheritance, `task`, `context`, and `files` must be self-contained.

## Background Delegation

Three execution properties, kept separate:

- **Foreground** (default): the call blocks until the run finishes and returns the final output directly. (Under the hood foreground and background share one async run engine — foreground is simply background-but-blocking.)
- **Parallel**: multiple `subagent_delegate` calls in one turn run concurrently — foreground and background alike, no special flag.
- **Background** (`background: true`): non-blocking — `subagent_delegate` returns immediately with a run id. Use it when you have your own work to do (or a discussion with the user to continue) while the run executes; four companion tools manage the outcome:

| Tool | Purpose | Returns to the model |
|------|---------|---------------------|
| `subagent_delegate(background: true)` | Start an async run | Just the id (`sub-N`) |
| `subagent_wait(ids?, timeout_ms?)` | Block until **all** listed runs finish (omit `ids` for all current background runs) | Statuses only, one `id (role): finished/failed` line per run — never results; errors when the timeout hits with runs unfinished |
| `subagent_check(id)` | One-shot snapshot of a single run | `queued` / `running` + current activity / the **full output** once finished / failure reason + partial output. Checking a terminal run **collects** it: the output is returned once and the run leaves the registry |
| `subagent_steer(id, message)` | Queue a mid-run correction into one running run (typically right after a check revealed it heading down a wrong path) | Confirmation that the steer is queued — delivered after the child's current tool batch, before its next LLM call; the run keeps its progress |
| `subagent_cancel(id, reason?)` | Kill one live (queued/running) run | Confirmation with the partial-output size — the run settles as `cancelled` (warning styling, same family as timeout/budget) with the reason in its error message; the partial output stays in the registry for `subagent_check` to collect |

Typical flow:

```json
[
  { "role": "worker", "task": "Implement the export module", "background": true },
  { "role": "researcher", "task": "Find the CSV escaping spec", "background": true }
]
```

…continue other work, then:

```json
{ "ids": ["sub-1", "sub-2"] }
```

(call `subagent_wait`), and finally `subagent_check` each finished id to fetch its result. `subagent_check` accepts one id per call because results can be large.

Semantics worth knowing:

- **Results are pull-only for the model.** A purple completion notice is shown to the user, but nothing delivers the result to the model or wakes it up. The notice is a pure notification in the same visual family as pi's `[compaction]` card — a `[subagent] id (role) outcome` header with the bare task preview beneath, each line truncated to the terminal width — and deliberately unlike the tool rows, so it never reads as model behavior; the result itself never appears in the notice, only in `subagent_check` (model) or `/subagent:status` (user). The model owns the collection point: `subagent_wait`, then `subagent_check` each run. The inbox reminder (below) lists runs not yet checked on the active branch on every request, but it never pushes results.
- **Background runs survive turn cancellation** and are unaffected by a cancelled `subagent_wait` — cancelling the wait never cancels the runs; call `subagent_wait` or `subagent_check` again later.
- **Idempotent check, session-tree delivery state:** `subagent_check` re-delivers the same terminal snapshot on every call — runs stay in the registry for the whole session, so no result can ever be stranded by branch navigation or compaction. Whether a run still needs collecting is not tracked in the registry: it derives from the session tree itself. The session is append-only, so branching back past a check entry drops it from the active path — the inbox reminder re-arms and the model simply checks again (the id still resolves; the run is still there). Branching forward to the original branch restores the check entry and silences the reminder again.
- **Cancellation keeps the partial output.** `subagent_cancel(id, reason?)` kills the child (SIGTERM, escalating to SIGKILL) and settles the run as `cancelled` — its own stop reason in the same family as `timeout`/`budget_exceeded` (TUI warning styling ⏹, not the error-red ✗ of real failures) — with whatever it had produced. The `reason` becomes the error message verbatim, so whoever reads the partial output later via `subagent_check` — or the audit history — sees `cancelled — <reason>`; the source is distinguishable too (`user: ...` for `/subagent:cancel`, the model's own words for the tool, `session shutdown` for reaping). Cancelling does not remove the run: `subagent_check` still returns the partial output, and `subagent_wait` reports the run as `cancelled (partial output kept)`.
- **Inbox reminder:** every LLM call carries a `[background subagent runs]` system reminder listing the runs not yet checked on the active branch (queued, running, and finished-but-unchecked alike, including cancelled ones — shown as `cancelled — <reason>`), injected at a cache-stable head position. Runs missing from the list were already checked on this branch — so a finished run the model forgot to check keeps surfacing until it does. Branch navigation keeps this honest: the list derives from the session tree, not registry bookkeeping.
- **`timeout_ms` is optional.** Without it, `subagent_wait` blocks until every run finishes; each run is still bounded by its own role timeout.
- Background runs share the global `maxConcurrency` gate — extra runs show up as `queued` in wait/check views.
- **Top-level only:** nested subagents cannot delegate in the background (a subagent process exits when its task finishes, which would orphan the run).
- The run registry lives in the pi process: a `/reload` or restart orphans in-flight background runs (their ids stop resolving). `/subagent:status` lists every registered run and its current state.

### Steering a running subagent

Steering queues a correction into a running subagent without killing it — the middle ground between waiting it out and cancelling. The message is delivered after the child finishes its current tool batch, before its next LLM call, so the run keeps its progress and can change course. It is a suggestion injected between turns, not an interrupt: the child may comply immediately, finish what it was doing first, or ignore poor instructions entirely — to actually stop a run, cancel it.

There are two channels into the same mechanism:

- **The model** calls `subagent_steer(id, message)` — typically right after a `subagent_check` snapshot revealed the run heading down a wrong path (check → steer → check again later).
- **The user** types into the input box of `/subagent:view`, targeting the focused run. Every accepted steer also appears in the run's activity feed as an `↩ steer:` entry, so whoever watches the view sees what was injected and when.

Queued steers are visible in neither wait nor check results — they shape the run's subsequent behavior, not its transcript.

### Background TUI display

Each tool row renders one aspect of the same decomposition the foreground row shows all at once (input · process · result · usage):

- **Background subagent_delegate row = input only.** Collapsed: `▶ sub-1 <task first line>`. Expanded: plus `@file` references, context size, inherited-conversation size/truncation metadata when enabled, and the full task text. Static — the run progresses invisibly until a subagent_wait/subagent_check row picks it up.
- **subagent_wait row = process + usage.** The input line shows the id list (or `(all)`) plus the timeout ceiling (`≤30s`) when one was given. One block per watched run: status line (`⏸ queued / ⏳ running` + id + task preview; bare, icon-free once terminal), a live activity stream (collapsed keeps the latest 5 items with a leading ellipsis; expanded shows everything) and a ticking usage bar. Once a run finishes, its process stream is replaced by a **status-only** result line (`✓ finished` / `⏲ budget-exceeded with the reason` / `⏱ timed out` / `⏹ cancelled with the reason` / `✗ <reason>`) — the output itself never appears in a subagent_wait row; expanded keeps the full process stream instead. A timed-out wait freezes the view.
- **subagent_check row = the result view.** Same block shape as subagent_wait's single-run view (no id — there is only one), but the result line shows `✓ <AI summary>` (or the budget/failure reason when the run stopped early) and the expanded view renders the **full output** — subagent_check is where the conclusion lives.
- **subagent_cancel row = confirmation only.** Collapsed: `⏹ sub-1 (worker): cancelled after 1 turn (~29s)` (or `• sub-1 (worker) already finished — nothing to cancel` for a no-op). Expanded adds the reason and the pointer to `subagent_check` — the partial output **never renders here**; it stays in the registry until a check row fetches it (layer contract: delegate = input, wait = process, cancel = intervention, check = result).

### Passing context and reference files

pi-subagent delivers context to the child as **independent channels**, never fused into the task string. This keeps the task an unambiguous directive and lets each channel be sized independently.

#### `context` (inline text)

Hand the subagent precise context — selected code, a prior delegate's result, a file list, a git diff — without inflating the `task` string. It's delivered as a separate channel:

```json
{
  "role": "worker",
  "task": "Add input validation to the login function",
  "context": "Current implementation (src/auth.ts:42-70):\n```ts\nasync function login(email, pw) { ... }\n```\nValidation must reject empty/invalid emails and enforce a min 8-char password."
}
```

The stored/displayed task stays as the original `task`. `context` is delivered as a `<context>` block ahead of the task in the child's initial prompt — the prompt travels over stdin, so size is not argv-bound and no spill file is involved.

#### `files` (reference paths)

```json
{
  "role": "explorer",
  "task": "Report the public API of the auth module",
  "files": ["src/auth.ts", "src/auth.types.ts"]
}
```

Each path is injected as an independent `<file name="...">` block in the child's initial prompt — the same wrap pi applies to `@file` arguments. **File contents stay out of your context window** — you pass only the paths; this process reads the bytes off disk and pipes them straight to the child. Prefer this over pasting file contents into `context`, since the child receives the content on its first turn without spending a tool call to read it.

### Budget enforcement

`maxTurns` / `maxCost` cap a run. When exceeded, the child is killed and the last completed output is returned with `stopReason: "budget_exceeded"`. Budget stops are **intentional finishes** — the output is partial but valid: the TUI marks the run with a ⏲ line stating the reason, `subagent_wait` reports `finished (budget exceeded — output is partial)`, and the tool result (and `subagent_check`) append a `--- Budget exceeded (...) ---` note so the model knows to treat the output as partial. Defaults are unlimited (`0`); set global defaults in config or per-role overrides in `agentOverrides`. Negative values are normalized to `0`.

### Oversized outputs

When a run's output exceeds the size limit (50,000 chars), pi-subagent first tries to **compress** it with the summary model (same role configured under `summary.role`) into a compact form that preserves conclusions, code, file paths, and errors. If compression fails or doesn't shrink enough, it falls back to mechanical head+tail truncation. The prepared text is what the main model receives and what the expanded TUI renders; a hint line notes which method was used. The **full raw output is always kept in the history file** for auditing.

### Fallback observability

When a provider error (429, quota, timeout, ...) kills a run and the whole task is retried on the role's `fallbackRole`, the retry no longer hides the failure. The first attempt's model, stop reason, error message, and a stderr tail are snapshotted into `fallbackFrom` and surfaced everywhere: a `⚠ fallback:` line in the TUI (collapsed and expanded, including while the retry runs), a `--- fallback: ... ---` note in the tool result the main model reads (on success and failure alike — foreground delegate results and `subagent_check` snapshots), and a `fallbackFrom` field in the history file. When the child dies before its first message (e.g. an instant 429), the reason is recovered from stderr and the model name from what the parent requested.

### Run history

Every **spawned** delegate run is written (best-effort) to `~/.pi/subagent/history/{sessionId}/{toolCallId}.json` — finished, failed, and aborted alike (an aborted run already consumed tokens, so its partial activity and cost stay auditable). Records cover role, task, usage, activity log, the **full raw output** (even when the main model saw a compressed/truncated version), and the `fallbackFrom` snapshot when the run was retried on the fallback role. Runs that never spawned (cancelled before starting — at the concurrency gate or during model resolution) are not recorded. Useful for auditing what subagents did and how much they cost. Disable with `history.enabled: false`.

## License

MIT
