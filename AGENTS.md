# Pi Extensions Monorepo

> This repository is a collection of extensions for **pi** (coding agent harness, npm package `@earendil-works/pi-coding-agent`) — all `@d3ara1n/pi-*` packages are developed and published here.
>
> When investigating a `pi-xxx` extension, follow this order:
>
> 1. **Check `packages/` first** to see whether it is developed in this repository (all local packages are `@d3ara1n/pi-*`).
> 2. Found in `packages/pi-xxx/` → read the source directly; it is the source of truth, and web searches only waste time.
> 3. Not found → it is a third-party package; search the web or inspect `node_modules/`.
> 4. **When uncertain, ask the user** which package it is and whether it is local — asking beats guessing wrong.

## Repository Layout

```text
packages/        Extension and library packages — each subdirectory is an independently published npm package
  pi-xxx/        Directory name matches the package name (@d3ara1n/pi-xxx)
plans/           Design documents
publish.{js,sh}  Release scripts
```

A package uses the same base name everywhere (with predictable casing/prefix transforms for the last two):

| Location | Form | Example (`pi-scout`) |
|---|---|---|
| Repository directory | `pi-xxx` | `packages/pi-scout` |
| npm package name | `@d3ara1n/pi-xxx` | `@d3ara1n/pi-scout` |
| Commit scope | `(pi-xxx)` | `(pi-scout)` |
| `settings.json` extension path | Absolute directory path | `.../packages/pi-scout` |
| `settings.json` config key | Strip `pi-` prefix, convert to camelCase | `scout` |

---

## Commit Conventions

All commits must follow Conventional Commits:

```text
<type>(<scope>): <description>
```

- **type**: `feat` | `fix` | `chore` | `docs` | `refactor` | `style` | `test`
- **scope**: package directory name, such as `pi-context-include`
- Append `!` for breaking changes: `feat(pi-context-include)!: change config format`

- **Do not commit without explicit user approval.** Show the diff or a summary after editing and wait for the user to confirm before running `git commit`, even for tiny changes such as README fixes.

### AI Commit Attribution

AI-assisted commits include both a `Co-Authored-By` trailer for the model and an `Agent-Harness` trailer for the agent software in one contiguous trailer block at the end of the commit message:

```text
Co-Authored-By: <model-id> <provider-noreply>
Agent-Harness: <harness-name> (<harness-url>)
```

- **Model ID**: Obtain the actual model name from available environment information before each commit rather than relying on memory or reusing an earlier trailer, and extract the vendor's model ID; ask the user only when it cannot be determined. Drop relay prefixes (such as `provider/`), channel markers (such as `[Kiro]`), and variant suffixes (such as `-thinking` or `-high`), so `[Kiro]claude-opus-5-5-thinking` becomes `claude-opus-5-5`.
- **Provider email**: Always use the model vendor's noreply address regardless of relay or channel: `noreply@anthropic.com` (`claude-*`), `noreply@openai.com` (`gpt-*`, `o1*`, `o3*`, `o4*`, `codex-*`), `noreply@google.com` (`gemini-*`), `noreply@x.ai` (`grok-*`), `noreply@deepseek.com` (`deepseek-*`), `noreply@qwenlm.ai` (`qwen*`), `noreply@zhipuai.cn` (`glm-*`), `noreply@moonshot.cn` (`kimi-*`), or the known vendor's noreply address for other vendors. Only when the model vendor is genuinely unknown, use `noreply@unknown.invalid`; never invent a vendor domain or reuse an unrelated tool domain.
- **Agent harness**: Identify the agent software from available environment information and include its canonical homepage URL in parentheses when known (for example, `Agent-Harness: Asterism (https://asterism.dearain.dev)` or `Agent-Harness: pi (https://pi.dev)`). If the harness URL is unknown, omit the parenthesized URL and write only `<harness-name>` rather than guessing.

### Examples

```text
feat(pi-context-include): 支持嵌套 @ 引用
fix(pi-context-include): 修复 ~ 路径展开在 Windows 上的问题
chore: 更新依赖
docs(pi-context-include): 补充 README
```

Full commit message example (AI-assisted):

```text
fix(pi-subagent): 区分后台任务状态并明确等待与纠偏规则

Co-Authored-By: glm-5.3 <noreply@zhipuai.cn>
Agent-Harness: pi (https://pi.dev)
```

### Automated Releases

Pushing to `main` triggers automated GitHub Actions publishing:

- `feat` → minor
- `fix` → patch
- `!` or `BREAKING CHANGE` → major
- Other types do not trigger a release

---

## Development Conventions

### Installation and Loading

Add the absolute path of a package directory to the `extensions` array in `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/home/chien/Projects/pi-extensions/packages/pi-model-roles",
    "/home/chien/Projects/pi-extensions/packages/pi-scout",
    "/home/chien/Projects/pi-extensions/packages/pi-subagent"
  ]
}
```

- Do not use symlinks in `~/.pi/agent/extensions/` together with `settings.json`, or extensions will be loaded twice.
- `"pi": { "extensions": ["./src/index.ts"] }` in `package.json` tells pi which file is the extension entry point.
- `"keywords": ["pi-package", "pi"]` — every pi package must include both keywords (`pi-package` marks npm publishing, `pi` enables npm search discovery).

**Loading order for pure library extensions**: Even pure dependency extensions (registering no tools or commands) must register a hook such as `session_start` to initialize their state. pi loads extensions in list order, while `session_start` fires after all extensions have loaded, so **dependency extensions do not need to appear before their consumers**.

### Inter-Extension Data Sharing: Types via `import`, State via `globalThis`

When extension A (pure dependency library) is consumed by extension B:

- **Types via `import`** — B gets full type inference, IDE completion, and compile-time checks via `import { getModelRolesAPI } from "@d3ara1n/pi-model-roles"`.
- **State via `globalThis`** — A's internal singleton state must live on `globalThis`, not in a module-level `let`.

**Why**: pi loads extensions from `settings.json` using absolute paths (e.g., `/home/chien/Projects/pi-extensions/packages/pi-model-roles/src/index.ts`), while consumers import via workspace symlinks (`node_modules/@d3ara1n/pi-model-roles/src/index.ts`). Both resolve to the same file, yet Bun's module cache can treat them as two separate modules with separate module-level variables. `globalThis` is process-wide and immune to module identity splitting.

```typescript
// Pure dependency library (pi-model-roles/src/api.ts)
const GLOBAL_KEY = "__piModelRoles";

export function initModelRolesAPI(...): ModelRolesAPI {
  const api = ...;
  (globalThis as any)[GLOBAL_KEY] = api;  // Store state on globalThis
  return api;
}

export function getModelRolesAPI(): ModelRolesAPI {
  const api = (globalThis as any)[GLOBAL_KEY];
  if (!api) throw new Error("not initialized");
  return api;  // Type-safe; consumers still receive ModelRolesAPI
}
```

```typescript
// Consumer (pi-scout/src/index.ts) — transparent
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";  // Type-safe
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
const roles: ModelRolesAPI = getModelRolesAPI();  // Full type inference
```

### Command and Configuration Conventions

**Configuration keys**: Strip the `@d3ara1n/pi-` prefix and **convert to camelCase**:

```jsonc
{
  "modelRoles": { ... },   // @d3ara1n/pi-model-roles
  "scout": { ... },        // @d3ara1n/pi-scout
  "subagent": { ... }      // @d3ara1n/pi-subagent
}
```

**Config loading: project replaces global whole-block, without field-level deep merge.** Loading reads global `~/.pi/agent/settings.json` plus project `.pi/settings.json`; **project configuration replaces global whole-block** (`projectRaw ?? globalRaw`), with missing fields filled from `DEFAULT_CONFIG` via per-field `??`. This matches pi itself and `pi-access-denied` (locked by tests).

Do not write recursive `merge()` helpers for config loading: most configs are flat, and whole-block replacement has clear, predictable semantics. Keep deep merging only as an explicit exception when **partial per-key override across files** is genuinely required—currently only `pi-model-roles` (so a project can override `model` on one role while keeping `provider` from global).

**Command registration**: pi supports colon-separated command names—register `pi.registerCommand("scout:skill-router", { ... })` so users invoke `/scout:skill-router on` rather than manually parsing subcommand args inside one command.

### Prompt Copy Layering (`description` / `promptSnippet` / `promptGuidelines`)

All four teaching layers enter every LLM request (tool/parameter `description` in tool schemas, `promptSnippet`/`promptGuidelines` in the system prompt). Teaching the same fact twice doubles tokens and dilutes both. Each fact belongs in one layer only—check ownership before writing:

| Layer | What it teaches | Example |
|---|---|---|
| tool `description` | Contract: what the tool does and returns | `"wait returns status only, never results"` |
| param `description` | Contract: how parameters work and relate | `task`/`context`/`files` channel separation |
| `promptSnippet` | One-line entry in the Available tools list | |
| `promptGuidelines` | Policy: when to use, cross-tool orchestration, bans | `"Do not delegate trivial work"`, Typical flow, read-once collection |

Adding guidance to whichever layer feels handy during feature edits causes `promptGuidelines` bloat; check the other three layers before adding new text.

### No Cross-Extension References in Prompt Copy

Never mention **other extensions' tool or command names** in `description`, `promptSnippet`, `promptGuidelines`, or parameter descriptions, unless that extension is a declared hard dependency of the package (such as `pi-mesh` for its consumers). Absolute claims such as "only / the only way" are likewise forbidden—they hold only within the current extension set, and users can install third-party alternatives.

**Why: composability.** Users may install only one extension or swap in a competitor—referencing an absent extension creates a ghost reference or misleads the model. Boundaries between tools should emerge naturally from stating each tool's own semantics accurately (e.g., read-only and invisible to the peer vs. entering the peer's conversation flow as an actionable prompt).

### Register Orchestration and Interactive Tools as `model-only`

pi's `ToolExposure` defaults to `direct`: declared to the model while also callable from codemode scripts via `ctx.executeTool()` (the script's `tools` object). Tools whose semantics depend on the top-level turn lifecycle must set `exposure: "model-only"` explicitly (declared to the model, never callable from scripts):

- **Orchestration / long blocking** — manages child task lifetimes or turn-level waits (`pi-subagent`: foreground calls block the script until timeout/cancel, and running tasks are aborted when the script ends).
- **Human interaction** — blocks waiting for user response (`pi-ask-user`: script teardown/timeout/abort cancels the pending dialog and loses user input).
- **Cross-agent messaging** — replies arrive as `[From: ...]` user messages after the turn finishes (`pi-chat-room`'s `send_to`: scripts can never observe the reply).
- **Contract tied to direct model calls** — core contract relies on direct sampling (`pi-apply-patch`'s Lark grammar-constrained sampling would be bypassed by script calls; scripts edit files via direct file tools).

Shared criterion: if a call's meaning depends on top-level turn waiting, user response, or side-effect ownership, running it inside a script causes it to block until cancelled or lose its effect. Append this exact verbatim sentence at the end of such tools' `description` across all packages:

> Direct tool call only — not callable from codemode scripts: it is absent from the script's `tools` object.

### README and Dependency Documentation

**Every package README must include `## Installation` and `## Dependencies`.** Even infrastructure extensions consumed only by other extensions (registering hooks without tools or commands) must include `## Installation` explaining how to load them.

**Never state pi version requirements in READMEs.** Extensions always target the latest pi release; do not declare `"Requires pi X.Y or later"`. Use new APIs directly and describe behavior without pinning version numbers.

**Extension vs. Library classification:**

- **Extension** — contains resources pi must load, such as `pi.extensions`, skills, prompts, or themes. Even if it only registers hooks and no commands or tools, it is an extension and must be explicitly installed and loaded by the user.
- **Library** — contains no pi-loadable resources and only exports types, functions, or shared state for other packages to import (such as `pi-usage-block-core`). npm installs it automatically as a normal dependency; it must not be added to pi's `extensions` list.

**npm dependency ≠ pi loading.** npm's `dependencies` installs packages into `node_modules/`, which does not make pi load extension/skill/prompt/theme resources declared by a dependency. If extension A depends on extension B (e.g., `pi-peek-user` depends on `pi-peek`), **both** must appear in `settings.json`'s `extensions` array. If A depends only on pure npm library C, declare C in `dependencies` and the README's `## Dependencies` section only.

**Main README dependency markers:** In the Extensions table, mark rows requiring extra extension dependencies with footnotes (`<sup>†</sup>` / `<sup>‡</sup>`) and explain all footnotes right below the table. Pure npm library dependencies do not use footnotes.

**Per-package README `## Dependencies` format:**

```markdown
## Dependencies

- [`@d3ara1n/pi-xxx`](../pi-xxx) — Purpose description
```

List direct `@d3ara1n/pi-*` dependencies within this repository, including required extension dependencies, automatically installed pure libraries, and optional integrations (clearly marked optional). Omit framework peer dependencies bundled with pi (`pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`, etc.).

**Fixed `## Installation` format:**

```markdown
## Installation

```bash
pi install npm:@d3ara1n/pi-xxx
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-xxx"
  ]
}
```
```

- **Extension dependencies**: A consumer README's `## Installation` must recursively list `pi install` commands for all required extensions in dependency-first order; the local-path example must list them as well.
- **Pure npm library dependencies**: Declare only in `## Dependencies`; do not add a separate `pi install` command or add them to `settings.json` `extensions`.
- **Pure library's own README**: Use `npm install` under `## Installation` and explicitly note that it is not a standalone pi extension.
- **Optional extension dependencies**: Keep out of the main install command; document separately how to install and enable them.

**`## Model Compatibility` section (optional):** When testing uncovers model-specific behavior differences, document them under `## Model Compatibility` with one `###` subsection per model family (e.g., `### GPT family`), noting in the intro that observations apply to the primary model. Place it early (after the intro/design overview) as pre-install guidance. **Omit the entire section if there are no real observations—never write placeholders.**

### Language Rules: Community-Facing Content Must Be English

This repository is an English open-source project. **Artifacts read by the community or international users must be in English**; only local/internal artifacts may use Chinese.

**Must be English**:
- `AGENTS.md` and package `README.md` files (npm/GitHub international audience)
- Source comments (JSDoc and inline comments — open-source collaboration, IDE tooltips, future contributors)
- Model- and user-facing strings: `description`, `promptSnippet`, `promptGuidelines`, error messages, `package.json` `description`, and test titles (`test("...")`)

**May be Chinese** (local/internal artifacts):
- Commit message subjects and bodies (repository convention allows Chinese)
- `plans/` design documents (internal design notes)
- Conversations with the user

Rule of thumb: **If it appears on npm/GitHub or enters the model's system prompt, it must be English.**

### Provider Development

When writing a new pi provider (`pi-provider-xxx`), follow the verification methodology in `PROVIDER.md` — never write compatibility settings from memory; verify every `compat` dimension empirically.

### Testing and Reloading After Changes

After editing extension source under `packages/*/src/**` or modifying `extensions` in `~/.pi/agent/settings.json`, **the user must manually reload** pi—pi loads extensions at startup and does not hot-reload at runtime.

After finishing an extension change, **do not test immediately**; remind the user first:

- Run `/reload` to reload extensions, or restart pi.
- Wait for the user to confirm reload completion before testing.

This is critical for features that **require LLM interaction to verify** (new tools/commands, modified prompts, etc.)—testing before reload hits stale code and produces misleading results.

Agent boundaries:

- Edit source and run `npx tsc --noEmit` to verify types — inside the project, agent-autonomous.
- Add the extension path to `settings.json` (touching only that array).
- Never run `pi --reload` or kill/restart the pi process — reloading is always manual by the user.

---

## Lessons Learned

### `ctx.ui.custom` Interactive Panels: Bottom Panels Must Use `overlay: false`

When implementing bottom interactive panels with `ctx.ui.custom` (permission prompts, multi-question dialogs, etc.), **always set `overlay: false`**.

**Problem with `overlay: true`**: `ui.showOverlay()` covers the full screen and obscures the chat transcript, preventing scrolling—users cannot read agent instructions while operating the panel. Both `pi-ask-user` and `pi-access-denied`'s `AuthPanel` previously hit this pitfall.

**Correct approach**: `overlay: false` renders into the bottom `editorContainer` slot (shared with `ctx.ui.select()` / `input()`), keeping the transcript visible above. Scrolling works in both `tuiMode` settings: `fullscreen` (default since pi 1.0) scrolls inside the app, and `"regular"` uses native terminal scrollback. Keyboard focus transfers automatically to the panel with intact arrow-key navigation.

Reference: `AskUserPanel` in `pi-ask-user` and the fixed `AuthPanel` in `pi-access-denied`.

### Do Not Use `/tmp` as a Test Root for `pi-access-denied`

`pi-access-denied`'s `PathManager` treats `/tmp`, `os.tmpdir()`, and `/dev/null` as **builtin allow roots** (task-scoped scratch paths reclaimed by the OS without persistent footprint). These builtin rules compete on equal footing with configured `allowedPaths`/`deniedPaths` in longest-prefix matching.

**Pitfall**: Testing a config **allow** rule with `/tmp/ad-test/...` hits the builtin `/tmp` rule first—making a test pass even if the configured allow rule is broken (though `deny` rules still override builtin allow).

**Correct approach**: Test configured rules against a non-builtin path under home (such as `~/ad-test/...`) so allow decisions genuinely exercise your rule. Inspect `builtinSafeRoots()` in `paths.ts` or the Allow rules block of `/access-denied status` for the full list.

### The Bash Gate Is Per-Call: One Out-of-Bounds Path Blocks the Whole Command

`pi-access-denied` intercepts the entire `tool_call`. If token scanning finds multiple out-of-bounds paths in one bash command, **blocking any one of them blocks the entire `bash` call** before anything executes.

**Testing impact**: To verify allow/deny decisions across multiple paths, **never** pack them into one `bash` command (e.g., `cat a; cat b; cat c`)—nothing after the first blocked path runs. Split them into separate `bash` calls, one path per call.

**Design rationale**: The gate cannot know whether operations in `A && B` have side-effect dependencies, so conservative whole-call blocking is safer and encourages agents to keep commands single-purpose with explicit path scope.

### TypeScript Typechecking and Test Commands (Monorepo Structure)

Toolchain layout dictates the right commands (see global `~/.agents/node-development.md` for host Node setup):

**Project structure:**

- Monorepo with a single `tsconfig.json` at the **repository root**; subpackages have no individual tsconfig (`include: ["packages/*/src/**/*.ts"]`).
- Tests use Node built-in `node:test` + `node:assert` (no bun/tsx/vitest).

**Correct commands:**

| Purpose | Command | Notes |
|---|---|---|
| Typecheck (whole monorepo) | `npx tsc --noEmit` | Works from repo root or any subdirectory (`tsc` walks up to root tsconfig) |
| Run a package's tests | `node --test packages/xxx/src/*.test.ts` | Native Node execution of `.ts`, zero extra dependencies |

**Anti-patterns:**

- `npm run typecheck` inside a subpackage — subpackage `package.json` lacks this script (`Missing script`).
- `cd packages/xxx && tsc src/index.ts --noEmit` — bypasses root `tsconfig.json`, losing path mappings and compiler options.

**Why**: The monorepo shares one root tsconfig, so typechecking is monorepo-wide in one pass.

### Test Layering Principles

- Default tests must be offline, deterministic, and repeatable; isolate external processes, network, model APIs, user directories, auto-install, and persistent state via dependency injection and fakes.
- Real-boundary checks belong in explicit integration tests excluded from default scripts; integration tests must use temporary sandboxes, clean up after themselves, and skip cleanly when dependencies are absent.
- Restore any mutated globals, environment variables, timers, and mocks at test teardown so tests never leak across cases or into the user environment.
- Do not write TUI rendering layout/color/alignment or "does not throw" smoke tests—inspect visual issues in a real terminal. Render functions may serve as observation points for behavioral contracts (state transitions, anti-leakage, sanitization, interaction protocols) where assertions check behavior rather than appearance.

### Never Strip Comments from JSON Config Files

When reading **standard JSON** files such as pi's `settings.json` or npm's `package.json`, never write regex comment strippers (`content.replace(/\/\/.*$/gm, "")`) to "support JSONC". This is **useless and destructive**.

**Why regex stripping is wrong:**

- Standard JSON forbids comments—comments are a syntax error that `JSON.parse` should reject.
- Regex stripping truncates **`//` inside string literals** (e.g., turning `"https://example.com"` into `"https:`), causing silent `JSON.parse` failures swallowed by `catch` blocks and breaking user configs invisibly.
- Regexes cannot safely strip comments inside strings, escapes, or nesting; real JSONC requires a dedicated parser (`jsonc-parser` or `strip-json-comments`).

**Correct approach:**

- Standard JSON → **call `JSON.parse` directly** and let errors throw (falling back to defaults in `catch` if appropriate), with **no preprocessing**.
- Use a dedicated JSONC parser only for formats explicitly specified to allow comments (`tsconfig.json`, `.vscode/*.json`, explicit `.jsonc`).

**Case in point**: Early `pi-context-include` stripped comments while reading `settings.json` and silently broke URLs in user config. Removed—plain `JSON.parse` lets invalid files fail visibly.

### Mark Test-Only Exported Helpers `@internal`

When a function is exported solely for tests (or read by tests alongside internal production code) and **must not be part of the public API**, tag its JSDoc with `@internal` so it does not pollute consumer IDE completions or type inference.

```typescript
/**
 * @internal — exported for testing; use {@link underRoot} in production.
 */
export function posixUnder(posixTarget: string, posixRoot: string): boolean {
```

**Criteria**:

- Pure internal helper needing isolated unit tests → `@internal`
- Public API imported by production consumers → no `@internal`

**Examples in this repository**:

- `posixUnder` in `pi-access-denied` — internal helper behind `underRoot`, tested directly → `@internal`
- `extractReferences` in `pi-context-include` — also called internally by production code, not meant for consumers → `@internal`

### Cross-Workspace Dependencies Must Use `"*"`, Never `"workspace:*"` or `"^x.y.z"`

npm **has never implemented** the `workspace:` protocol (npm/cli#8845; documented but rejected by the parser), and `"^x.y.z"` triggers registry lookups that churn lockfile versions on every `npm install`.

**Correct approach**: Use `"*"` for intra-monorepo dependencies so npm workspaces resolves them locally by package name without hitting the registry.

```jsonc
// ✅ Correct
{ "dependencies": { "@d3ara1n/pi-model-roles": "*" } }

// ❌ Wrong — npm fails with EUNSUPPORTEDPROTOCOL
{ "dependencies": { "@d3ara1n/pi-model-roles": "workspace:*" } }

// ❌ Wrong — causes lockfile version churn
{ "dependencies": { "@d3ara1n/pi-model-roles": "^0.1.0" } }
```

**Follow this rule whenever creating new packages** to avoid reintroducing lockfile churn.

### Route Interactive UI by `ctx.mode`, Never `ctx.hasUI`

pi has four session modes (`tui | rpc | print | json`). Extensions registering interactive UI must **branch by mode**: full `ctx.ui.custom()` panels in `tui`, falling back to `ctx.ui.select()`/`confirm()` dialogs in other modes—check `ctx.mode`, never `ctx.hasUI`.

**Why `hasUI` lies**: RPC mode binds a stub `uiContext` (`select`/`confirm`/`input`/`editor` work via the `extension_ui_request` sub-protocol, while `custom()` silently returns `undefined` because TUI component factories cannot cross JSONL). Thus `hasUI` is **true** under `rpc`. `pi-subagent` children run in `rpc` mode: `ask_user` previously slipped past `hasUI` and threw a bare `TypeError` reading `result.answers`.

**Promise degraded-track capabilities only along the protocol intersection**: `select`/`confirm` are natively guaranteed by both pi's extension sub-protocol and ACP (`session/request_permission` uses free-form strings for option names/IDs), handling any single-choice prompt losslessly. `input`/`editor` have no ACP text-input primitive (a protocol gap, not an adapter bug), so features relying on them must probe adaptively (e.g., verify one `input` succeeds before enabling dependent actions) rather than polling unconditionally. Keep the degraded JSON return contract identical to the TUI track so LLMs see no mode difference. Under `print`/`json`, dialogs cleanly resolve as cancelled.

Reference implementations: `dialogDecision` in `pi-access-denied` and `dialogAsk` in `pi-ask-user` (both `tui ? custom() : dialog` two-track branches).

### Design New Extensions for Multi-Mode (`RPC`/`ACP`) by Default

Design every new extension assuming non-TUI hosts (ACP editors, `--mode rpc`, `print`/`json`), checking against these capability tiers:

- **Always return plain-text `content` from tools** — the common denominator across all four modes, requiring zero adaptation. `pi-tui` renderers (`renderCall`/`renderResult`) load only in TUI and are harmlessly absent in RPC; `execute()` must never depend on renderer presence.
- **Fire-and-forget UI works natively in RPC**: `setStatus`, `setWidget(string[])`, and `notify` forward over `extension_ui_request`. Component-factory APIs (`custom`/`setFooter`/`setEditorComponent`/`getEditorText`) are TUI-only and no-op or return empty values in RPC—either build a degraded dialog track (see above) or accept silent absence.
- **Extension slash commands are currently unreachable in mainstream ACP adapters**: interactive features triggered by commands should either guard on `ctx.mode` with an actionable message or also expose a tool equivalent.
- **Run a mode self-check after changes**: How does this extension behave in Zed + `pi-acp`? Tools callable, progress visible, and interaction degraded or cleanly unavailable—never crash on call.

### Foreground Color Hierarchy Around the Editor (`dim` / `muted` / `text`)

Any UI rendered around the editor chrome (`pi-editor-shell` frames, `setWidget`, `setStatus` items, custom footers) chooses foreground tokens in descending visual hierarchy:

| Token | Role | Examples |
|---|---|---|
| `dim` | Tertiary: typographic punctuation & lowest-priority hints | Separators `·`, decorative dots, `↑↓ navigate` key hints |
| `muted` | Secondary text: readable without competing for attention | `cwd`, timer digits, unselected items, status labels |
| `text` | Neutral emphasis: stronger than `muted`, weaker than `accent` | Active mode, selected option, or neutral callouts without semantic color |

Peripheral UI uses `muted` by default for regular information; reserve `text` for items that need emphasis where `accent` or `success`/`warning`/`error` semantic colors do not fit. Because `text` already stands out around the editor, never apply it to whole paragraphs of routine chrome; save `accent` for focus, brand, or primary emphasis. pi officially defines `muted`/`dim` as secondary/tertiary text; this repository further standardizes typographic punctuation and lowest-level hints on `dim`.
