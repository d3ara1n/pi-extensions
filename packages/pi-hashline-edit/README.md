# @d3ara1n/pi-hashline-edit

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-hashline-edit)](https://www.npmjs.com/package/@d3ara1n/pi-hashline-edit) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-hashline-edit)](https://www.npmjs.com/package/@d3ara1n/pi-hashline-edit) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-hashline-edit)](https://www.npmjs.com/package/@d3ara1n/pi-hashline-edit)

> Hashline-style file editing for [pi](https://github.com/earendil-works/pi-coding-agent) — line-anchored edits verified by content hash (replacing `oldText`/`newText` matching), plus a location-blind `replace` tool for bulk + regex transforms.

Edits reference lines by `LINE#HASH` anchors (copied from `read`/`grep` output) instead of retyping the code to be changed — eliminating string-not-found loops and whitespace battles at the root.

## Why hashline?

The built-in `edit` matches `oldText`/`newText` exactly. When the model can't reproduce the source verbatim — wrong indentation, a non-unique snippet, or a line that drifted since the read — the edit fails and you loop. Hashline sidesteps all of it:

- **No string-not-found loops** — you edit by reference (`LINE#HASH`), not by retyping the line you want to change.
- **No whitespace battles** — the new content is the only thing you type; nothing has to match what's already there. Indentation mistakes on the *old* code are impossible.
- **Unique-by-construction hashes** — the line number is folded into the hash, so identical lines (blank lines, `}`) never share a hash and never collide.
- **Chain edits without re-reading** — a successful `edit` returns fresh anchors for the lines it produced, so the next edit cites them directly instead of forcing a full re-read.
- **Grep-to-edit, no detour** — search results carry the same `LINE#HASH` anchors (grouped by file, context lines included); grab one and edit directly, skipping the read you'd otherwise need.
- **Surgical drift detection** — each cited anchor is rechecked against the current line only; an unrelated change elsewhere never blocks your edit.
- **Self-healing stale anchors** — a drifted anchor (content shifted by an edit above it) doesn't force a full re-read: the applicator rescans ±lines for the original content and hands back a fresh `LINE#HASH` to retry with, only asking for a re-read when the content genuinely changed.

## When to use it

Routine local code editing in pi — the common case. If you spend turns fighting "old_string not found" or fixing indentation the model dropped, this is the fix.

## When to turn it off

Set `hashlineEdit.enabled = false` (or uninstall) to fall back to the built-in `read`/`edit`/`grep` when you need **remote or custom-storage files** — the overrides read/write/search the local filesystem directly, so pi's custom `ReadOperations`/`GrepOperations` (SSH, etc.) aren't supported. The same switch lets you opt out per-project. All four tools — `read`, `grep`, `edit`, `replace` — are one set governed by this switch: when disabled, `read`/`edit` and plain `grep` calls delegate to the built-ins (`grep` calls using the extended params below still run locally, formatted without anchors) and `replace` refuses (it has no built-in counterpart).

## Model Compatibility

Hashline replaces the edit protocol the main model was trained on, so real-world reliability depends on the model more than on anything else. Field observations from real sessions, one family per subsection (June 2026, single environment — directional, not benchmarks; vendors iterate fast, re-test on new releases).

### DeepSeek family

**Avoid — silent corruption.** Weak tool-call construction (tested: DeepSeek V4 Flash): ~50% of edits fail on the built-in string-replace, and each fix takes several more rounds — string-replace failures are *divergent*, the model retries from the same wrong memory, but at least they are loud. Hashline's rejected anchors *converge* — a mismatched anchor returns the live content plus a ready-to-resend `LINE#HASH`, so one retry closes the loop — but the raw failure rate is high (~80%), and hashline adds a failure class the built-in edit doesn't have.

`insert_after` semantics invite wrong parameters even when the tool call itself is well-formed: the model fills `body` string-replace-style, copying the anchor line into it (observed on DeepSeek V4 Flash). The toolcall verifies and succeeds, and the line ends up duplicated. Nothing at the tool layer can catch this — the anchor is valid, the model's *intent* was wrong, and no prompt wording cures it (the schema description already forbids the copy). For a weak model, hashline effectively trades loud failures for silent ones: files come out corrupted edit by edit. Keep the plugin off for this profile; if you must run it, review the diff after every edit.

### Kimi family

**Turn the plugin off.** Strong, but not trained on hashline (tested: Kimi K3): built-in string-replace is excellent while hashline draws frequent anchor mistakes. Hashline assumes anchor discipline — copy hashes verbatim from read output, never invent one; a model that hasn't internalized that fabricates anchors no matter how capable. When a strong model keeps hitting anchor errors, the fastest fix is disabling the plugin, not more retries.

### GLM family

**The intended pairing.** Strong and follows the schema as given (tested: GLM 5.2): the occasional not-found / whitespace friction of built-in string-replace disappears — 100% in testing. Capable models never needed the wording in the first place: GLM used `insert_after` correctly even when the tool description didn't explain the op at all. The mismatch lives in the model, not the tool.

### GPT family

**No reservations.** Structured ops are home turf for this family (tested: GPT 5.6 sol/terra/luna): no fabricated or mistyped anchors observed, and `insert_after` was never misused — the anchor-line-into-`body` duplication (see DeepSeek above) never occurred. The few rejected anchors were the *expected* kind: a size-changing `edit` invalidating the hashes of the lines below it between edits — the documented hash-drift tradeoff rather than a model error, and exactly what the self-healing rescan exists to rescue. Even those ran fewer than expected; small-sample observation, take it directionally.

## Gotchas (vs. the built-in `read`/`edit`)

Once hashline overrides the built-ins, a few things behave differently:

- **`read` is globally overridden.** Every read shows the `LINE#HASH│` prefix on each line — even reads that won't lead to an edit. This is expected (it's the substrate the reliability is built on), just don't be surprised when the format changes for all files.
- **Conservative overlap.** Two ops whose ranges touch (e.g. `insert_after` immediately followed by `replace` at the same line) are rejected to avoid backfill ambiguity — issue them as two separate `edit` calls.

## `replace` — bulk + regex

A separate, location-blind tool for transforms `edit` can't express: replace **all** occurrences of a string/regex across the whole file in one call. Use it for renames, normalizations, and pattern-based rewrites that would otherwise need many individual anchored ops.

- **Two modes** — `regex: false` (default) treats `find` as a literal substring (replaceAll; the replacement is inserted verbatim, no `$` expansion); `regex: true` treats `find` as a JavaScript pattern source and `replace` supports `$1`, `$2`, `$&`, …
- **Flags** — `flags` adds regex flags in both modes (`g` is always forced so every occurrence is replaced): `i` (case-insensitive), `m` (per-line `^`/`$`), `s` (dotall, `.` matches `\n`), `u` (unicode).
- **Safety** — a `maxMatches` cap (default 2000) errors *before writing* if exceeded, so a runaway pattern can't produce a catastrophic write. `0` matches is an error (no silent no-op).
- **Shares the edit queue** — `replace` and `edit` on the same file are serialized via the same mutation queue, so concurrent edits never interleave.
- **Returns a diff + fresh anchors** for the changed region, so a follow-up `edit` can chain on the new content without a re-read (when the region is small).

`edit` vs `replace`: `edit` is **surgical and verified** (you point at a `LINE#HASH` and the tool confirms the line is unchanged before rewriting it). `replace` is **global and unverified** (you give a pattern, it rewrites every match sight-unseen). Pick by intent: change a known spot → `edit`; transform every occurrence → `replace`.

## Design

- **Per-line hash + line number, dual anchor**: `read` shows each line as `3#aF3│code`; `edit` references `LINE#HASH`. The line number is the address; the hash is a checksum that the line at that address is still what was read.
- **Line folded into the hash**: each line's hash mixes its 1-based line number into its content, so every line is unique by construction — no in-file collisions, no length extension. The hash changes only when the line's own content changes, never when a neighbor changes.
- **Live, surgical verification**: at apply time each cited anchor's hash is recomputed from the current line content and compared — no stored snapshot, no whole-file stale check. A line that changed (or was misremembered) fails its own anchor; an unrelated change elsewhere never blocks the edit. No fuzzy matching, no boundary repair.
- **Shifted-anchor recovery**: a mismatched anchor isn't a dead end. The applicator rescans ±`shiftRadius` lines for the original content — holding the original line number fixed and re-hashing each candidate (`hash(line, candidate) === cited` iff the candidate *is* the original) — and returns a ready-to-resend anchor on a unique hit, the candidate list when ambiguous, or the cited line's live content when nothing matches. The model retries without a re-read in the common drift case.
- **Atomic batches, all failures collected**: every op in one `edit` is verified against the same snapshot; if any anchor fails, *all* failures (each with its recovery) are returned together and nothing is written — partial writes would shift lines and invalidate the very recovery info just returned.
- **Chain edits without re-reading**: a successful `edit` returns `Updated anchors` for the lines it produced (and the line that shifted into a deletion gap), so the next edit can cite them directly.
- **No legacy compatibility on `edit`**: `edit` accepts only structured hashline ops; sending legacy `oldText`/`newText` is rejected at the schema layer (never silently degrades) — so you always know whether hashline is actually in use. Bulk/regex replacement is a *separate* tool, `replace`, not an `edit` mode (see below).

## Why line hashes, not file tags

### The short version

This plugin is a line-hash editor: every line comes back tagged with a content hash that folds in its line number, and you edit by citing that `LINE#HASH`. That is, deliberately, the *original* hashline idea — the one omp shipped in February 2026 and then walked away from. omp's current engine anchors on a **whole-file** hash instead, and has since mid-2026. I looked at that route and stayed on the line-hash one on purpose. What follows is my case for that choice, stated as a tradeoff rather than a verdict — the honest limitations, including the ones that argue for the other route, come right after.

### Where this comes from

The idea that a model should edit by pointing at a **stable, verifiable anchor** instead of retyping code it already saw is not mine — it is can1357's, argued in [*The Harness Problem*](https://blog.can.ac/2026/02/12/the-harness-problem/) (2026-02-12), and omp's first implementation was exactly this shape: every read line tagged with a short per-line content hash, edits expressed as structured `old`/`new` ops. That first design had a real problem, and omp and I fixed it in opposite directions.

**Identical lines collide.** A per-line *content* hash gives every `}`, every `)`, every blank line the same hash — and a hash that is not unique is not an anchor. omp's fix was to stop hashing lines and hash the **whole file** instead: a 4-hex file tag, with no per-line hash in `read` output at all. My fix was to fold the line number into each line's hash, so two identical lines at different positions can never share one — unique by construction, no file-level state required.

That single divergence cascades into everything else. (It also means the picture most people have of "hashline" is the line-hash one: omp's own docs site still describes per-line anchors that its current implementation no longer emits.)

### The case against the file-tag route

I can't speak to omp's motives for the switch — collision-proofing a per-line hash is hard, and the file tag sidesteps it entirely. But the clearest *payoff* I see in a whole-file tag is one my design gives up: **awareness of edits made by anyone else.** If another process touches the file, its whole-file tag changes, the next anchored edit is rejected, and the model is forced to re-read fresh state. For a swarm of agents editing one tree, that is a genuinely good property. It costs three things I wasn't willing to pay:

- **The tag can't tell whether the model actually *read* a line.** A whole-file hash proves the file is byte-for-byte what it was — not that the model ever saw the specific line it is now rewriting. To stop hallucinated edits on never-displayed lines, omp carries a separate `seenLines` guard alongside the tag. A per-line hash *is* the proof of having-seen: you cannot cite `LINE#HASH` without having read that line's content. No side array needed.
- **It needs out-of-band state.** A 16-bit file tag "is not meaningful outside that store" (omp's own words) — it can collide, so omp keeps a `SnapshotStore`, an LRU of recent file versions, to disambiguate. My hashes are content-derived and self-contained: an anchor is verified by rehashing the current line at that number, at apply time, against nothing but the file on disk. **This plugin has no SnapshotStore, no seenLines array, nothing to keep in sync.** That is the point, not an omission.
- **The verification is coarse.** A whole-file tag couples every edit to the entire file: an unrelated change *anywhere* invalidates the tag and drags the whole patch through recovery. Line hashes verify only the lines you cite — an unrelated edit elsewhere never blocks you.

### Why a JSON schema, not a text DSL

The other visible difference: omp delivers edits as a **text patch language** (`PUT`/`CUT`/`REM`/`MV` today, `SWAP`/`DEL`/`INS` before that, JSON before *that*). This plugin uses **structured JSON ops**. Two reasons:

- **Validation belongs to the tool, not the model.** A JSON schema rejects a malformed op at the parameter layer before any logic runs. A text DSL puts the burden of emitting exactly-correct syntax back on the model, and the error rate is high enough that the DSL route accretes layer after layer of lenient parsing and heuristic repair to compensate — omp has shipped both, including a documented incident where the repair silently dropped content. The whole reason to anchor by hash was to stop depending on the model reproducing text perfectly; a hand-written DSL quietly reintroduces that dependency on the other side of the call.
- **The token savings aren't worth it.** A DSL saves a handful of structural characters per op. Against a higher malformed-edit rate and the cost of format churn — omp's patch syntax has broken compatibly five-plus times, stranding third-party ports on dead dialects — that saving is noise.

### Compared by capability

Not by version: omp's later generations refine the same whole-file-tag core, so the real comparison is *line-hash route* vs *file-tag route*.

| Capability | This plugin (line-hash) | omp (file-tag) |
|---|---|---|
| Anchor identity | per-line `LINE#HASH`, line number folded in | whole-file 4-hex `#TAG`, bare line numbers |
| Identical-line collisions | impossible by construction | n/a (no per-line hash); the file tag itself can collide in 16 bits |
| Out-of-band state | **none** | `SnapshotStore` (LRU) + `seenLines` guard |
| "Did the model read this line?" | proven by the anchor itself | needs the separate `seenLines` array |
| Verification granularity | only the cited lines (surgical) | whole file — any drift enters recovery |
| Concurrent external edits | not a goal; re-read to proceed | detected by design — tag change forces a re-read |
| Wire format | JSON schema ops | text patch DSL |
| Malformed edits | rejected at the schema layer | lenient parsing + heuristic repair |
| Format stability | one schema | ≥5 breaking format generations |
| Drift recovery | ±15-line rescan → fresh anchor, else re-read | line-remap replay, fail-closed |
| Expressiveness | fine-grained ops + separate `replace` | syntax blocks, cross-file registers, `REM`/`MV` |
| Read-time token cost | 2–4 chars per line | none at read time; cost moves to mismatch output |

### Honest limitations

Including the ones that argue *for* the route I didn't take.

- **Hash drift after an edit.** Because the line number is part of the hash, inserting or deleting lines changes every subsequent line's hash. A successful edit hands back fresh anchors for the region it just produced, and the ±15-line rescan rescues nearby drift — but to cite lines well below a size-changing edit, you re-read. That is the price of stateless verification: I keep no snapshot that would track those shifts for you. I consider it a fair trade for having no out-of-band state to corrupt or resync; a clean core matters more to me than saving a read.
- **No multi-agent story.** If several agents edit one tree, the file-tag route's external-edit detection is a real advantage this design does not have.
- **Hash transcription is itself error-prone.** Anchoring assumes the model copies the hash verbatim. It doesn't always: *"It sees `483:d4` in the input, writes `483:3a` in the output. Every model does this, including Opus."* ([geometricagi, *AST Edits*](https://geometricagi.github.io/2026/04/02/ast-edits.html), 2026-04-02). This is a failure class the built-in string-replace does not have — see Model Compatibility above; on a model that hasn't internalized anchor discipline, turn the plugin off rather than fight it.
- **The edit format may not be your bottleneck at all.** An independent benchmark ([nwyin, *edit-bench*](https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html)) found the hashline-vs-replace delta to be language-dependent — a real penalty on Python, neutral on TypeScript, a wash on Rust — and concluded that *"edit format is not the bottleneck"*: model-to-model differences dwarf format-to-format ones. It also found that the whitespace near-miss anchoring is meant to kill barely occurs — fuzzy matching triggered 0 times across 114 successful edits.
- **A silent success is worse than a loud failure.** Any anchor scheme is only as safe as its implementation. opencode's early hashline port returned `Updated` while writing to the wrong line ([issue #15424](https://github.com/anomalyco/opencode/issues/15424)) — a buggy anchor check manufactures false trust. This plugin's recovery is built to fail closed and hand back live content instead of guessing, but the warning generalizes.
- **Model dependence is real and not universally in my favor.** omp routes kimi, mimo, deepseek-v4-flash and step-3.7-flash *away* from hashline by default (they miscount anchors or drop the tag header). My own field notes agree on Kimi and disagree on DeepSeek — same model, opposite conclusions in different environments. There is no globally best edit format; there is a model × task × implementation triple.

## Protocol

`read` output (each line anchored):

```
src/foo.ts · 6 lines
1#aF3│import { compute } from "./util"
2#7Qk│
3#mP0│export function foo(x: number) {
```

`grep` output (results grouped by file, each line anchored — copy `LINE#HASH` straight into an edit):

```
src/foo.ts · 2 matches
3#mP0│export function foo(x: number) {
4#kLp│  return x + 1
src/util.ts · 1 match
10#aF3│  const z = compute(x)
```

The `grep` override also covers the compound queries that otherwise push models into bash pipelines:

- `matchMode: "all"` — a line must match **every** pattern (`grep A | grep B` without the pipe)
- `excludePattern` — drop matching lines (`grep -v`), applied after pattern matching
- `wordMatch` — whole words only (`rg -w`)
- `outputMode: "files"` / `"count"` — just the file paths (`rg -l`) or per-file counts + total (`grep -c`); `"files"` output pastes straight back as a `path` array
- `pattern` and `path` accept arrays — several patterns combined per `matchMode`, several search roots in one call

Filters run before the match limit counts, and context windows are rebuilt from surviving matches, so `limit` and `context` compose cleanly with `matchMode`/`excludePattern`.


`edit` takes `path` + `edits` (an array of ops, each with `op`, `anchor`/`end` `{line, hash}` from read, and `body` string[]):

```jsonc
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "replace", "anchor": { "line": 4, "hash": "kLp" }, "body": ["  return x + 1"] },
    { "op": "insert_after", "anchor": { "line": 6, "hash": "b2H" }, "body": ["", "export const bar = foo"] }
  ]
}
```

Ops: `replace` · `delete` · `insert_after` · `insert_before` · `append` · `prepend`. `anchor`/`end` = `{line, hash}` from read; `body` = new content lines (string[], omit for `delete`).

`replace` takes `path`, `find`, `replace` (+ optional `regex`, `flags`, `maxMatches`) and substitutes **every** match:

```jsonc
{
  "path": "src/foo.ts",
  "find": "oldName",
  "replace": "newName"
}
```

Regex with a capture group (rename `getName()` → `get_name()` everywhere):

```jsonc
{ "path": "src/foo.ts", "find": "get([A-Z]\w*)", "replace": "get_$1", "regex": true }
```

Case-insensitive literal rename across the whole file:

```jsonc
{ "path": "src/foo.ts", "find": "TODO", "replace": "FIXME", "flags": "i" }
```

## Configuration

Add a `hashlineEdit` field to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` in a project (project replaces global):

```jsonc
{
  "hashlineEdit": {
    "enabled": true,     // set false to fall back to the built-in read/edit
    "hashLen": 4,        // hash length, 2–8 (default 4)
    "shiftRadius": 15    // ±lines scanned to rescue a stale anchor (default 15; 0 disables)
  }
}
```

## Installation

```bash
pi install npm:@d3ara1n/pi-hashline-edit
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-hashline-edit"
  ]
}
```

## Dependencies

- No additional `@d3ara1n/pi-*` dependencies; peer `@earendil-works/pi-coding-agent` ships with pi (framework-level, not listed by convention).
