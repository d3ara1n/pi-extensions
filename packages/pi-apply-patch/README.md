# @d3ara1n/pi-apply-patch

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-apply-patch)](https://www.npmjs.com/package/@d3ara1n/pi-apply-patch) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-apply-patch)](https://www.npmjs.com/package/@d3ara1n/pi-apply-patch) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-apply-patch)](https://www.npmjs.com/package/@d3ara1n/pi-apply-patch)

Codex-compatible `apply_patch` editing for pi, limited to the current workspace by default.

GPT models accustomed to Codex can use the familiar freeform patch format. The extension registers the official Lark grammar through pi's constrained sampling API and implements patch parsing, context matching, and file operations in TypeScript. It has no additional runtime library dependencies.

## Dependencies

None. The extension uses the pi framework packages supplied by the host.

## Installation

```bash
pi install npm:@d3ara1n/pi-apply-patch
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-apply-patch"
  ]
}
```

After changing extension source or loading configuration, run `/reload` or restart pi.

## Configuration

The result-diff view and patch path policy are configurable via the `applyPatch` block in
`~/.pi/agent/settings.json` (or a project-level `.pi/settings.json`, which
replaces the global block entirely):

```jsonc
{
  "applyPatch": {
    "contextLines": 1,
    "maxChangedLines": 10,
    "workspaceOnly": true
  }
}
```

- `contextLines` — unchanged lines kept on each side of a changed region. `0`
drops surrounding context.
- `maxChangedLines` — changed (`-`/`+`) lines kept per changed region, counted
across removals and additions together. The rest collapse into one hint line.
- `workspaceOnly` — keep patch paths inside the workspace. Default `true`. Set
it to `false` to allow Add, Update, Delete, and Move outside the workspace;
the same canonical-path, duplicate-target, and symlink checks still apply.

`contextLines` and `maxChangedLines` bound the folded view, which is what the
TUI shows by default. `ctrl+o` expands the tool row to the full, uncropped
diff. A non-numeric, negative, or below-minimum value falls back to the default
above. `workspaceOnly` applies to both execution and streaming preview reads.
Changes apply after `/reload` or a restart.

## Tool and transport

The tool is named `apply_patch`. Its internal schema has one required string property, `input`.

For models with `compat.supportsOpenAIGrammarTools: true`, pi advertises a freeform custom tool with the official Codex Lark grammar. The model sends patch text directly. Pi converts it to `{ input: patch }` for execution and handles custom tool result pairing and history replay.

When grammar tools are unavailable, pi advertises a function tool with the same `input` parameter. Built-in Codex models enable grammar tools; custom gateway model definitions must accurately declare this capability. A gateway must support the corresponding custom tool protocol for freeform calls to work.

This uses the Codex custom-tool protocol, not the distinct OpenAI API built-in `type: "apply_patch"` tool. Existing pi editing tools remain available. No shell command or shell-call interception is installed.

The tool is registered with `model-only` exposure: it is declared to the model, but codemode scripts cannot call it — it is absent from the script's `tools` object, whose file edits go through pi's callable file tools instead.

While the model streams the patch, the tool row previews the files it has parsed so far. Completed updates use the same parser and matcher as execution to show a diff against the file on disk; additions show their proposed content and deletions show the file name. Sections still being written appear as colored patch lines. Invalid or unmatched sections show a warning without hiding the rest of the patch. Preview reads follow the same path policy as execution, including symbolic links and `workspaceOnly`. The preview disappears when execution starts.

## Patch format

```diff
*** Begin Patch
*** Add File: greeting.txt
+Hello
+
+Welcome
*** Update File: src/main.ts
@@ function greet() {
-  return "Hi";
+  return "Hello";
 }
*** Update File: old-name.txt
*** Move to: docs/new-name.txt
@@
 keep this text
*** Delete File: obsolete.txt
*** End Patch
```

Send the patch itself without Markdown fences or commentary. Function calls use the `input` string; freeform calls send the patch directly. The example assumes the Update, Move, and Delete sources already exist.

- **Add:** every content line starts with `+`, including blank lines (written as `+`).
- **Delete:** the file header has no body.
- **Update:** use nonempty hunks starting with `@@` or `@@ <existing line>`. Prefix unchanged context with a space, removals with `-`, and additions with `+`, before the original indentation. Blank lines also need their corresponding prefix. Unified-diff headers such as `@@ -N,M +N,M @@` are not supported.
- **Multiple edits:** each source file appears once per patch. Keep all its hunks under one Update header, in file order, with no overlapping context. Every hunk matches the file's content before this update; later hunks cannot match text inserted by earlier ones. Combine nearby edits into one hunk.
- **Locators:** `@@ text` locates a source line and searches after it. Do not repeat that line as the first context or removed line. To edit the locator line itself, use bare `@@` with surrounding context or locate an earlier line.
- **Insertion:** include unchanged context to insert at a specific location. A hunk containing only additions appends to the file, even when it has a text locator. `*** End of File` after a hunk body anchors matching to the end of the file.
- **Move:** place `*** Move to: destination` immediately after the Update header. A move requires a nonempty hunk; a context-only hunk preserves the content when renaming.

Read the relevant source before constructing an update. Reuse known current content and re-read when it may be stale. Copy removed and context lines literally, and include enough surrounding context to distinguish repeated snippets. Keep patches focused; after a failure, use the diagnostics and current file contents to correct the patch instead of resending it unchanged.

Matching attempts exact text first, then ignores trailing whitespace, then leading and trailing whitespace, then normalizes selected Unicode punctuation and spaces. Each pass searches the complete remaining range before the next, looser pass. Repeated context is accepted; the first match in the successful pass wins.

A BOM at the beginning of the source file is treated as metadata: the first line can match with or without it in the patch, and updates retain it. BOMs elsewhere remain literal content. LF and CRLF source lines share the same matching representation. Inline whitespace runs, zero-width characters, Unicode composition differences, and inserted or missing blank lines are not automatically ignored.

Unchanged context lines retain their original text and line endings, even when matching used a looser comparison. Explicit `-`/`+` replacements inherit the removed lines' endings in order; additional lines inherit the last removed line's ending. Insertions use the preceding source line's ending, falling back to the following line, then the file's first ending, then LF. Existing blank lines are retained unless explicitly removed.

Add overwrites existing files. Move writes the destination, overwriting it if necessary, then removes the source. Overwriting does not require the previous target contents to be readable as UTF-8; when an Add target cannot be read, its diff is unavailable. Missing destination directories are created. Paths are literal text, so quotes are part of a filename rather than shell quoting.

## Workspace and failure behavior

The workspace is `ctx.cwd` at execution time. With the default `workspaceOnly: true`, relative paths and absolute paths are accepted when both their resolved spelling and canonical location are within that workspace. Source paths, move destinations, existing symlinks, and the nearest existing ancestors of new files are checked. Dangling symlinks, non-file targets, and duplicate canonical source paths are rejected. The same boundary rule applies to Delete: a symlink pointing outside the workspace is rejected even when the operation would only unlink that symlink.

Set `applyPatch.workspaceOnly` to `false` to allow Add, Update, Delete, and Move outside the workspace. Relative and absolute paths are both accepted; the extension still resolves canonical paths, deduplicates targets, rejects dangling symlinks, and rejects directory targets. This is an explicit opt-in.

The extension performs these checks itself and does not integrate with a separate permission extension. Path checks are not an OS sandbox: they do not isolate other processes, eliminate filesystem races, or track hard-link destinations outside the workspace. With `workspaceOnly: false`, `apply_patch` can write or delete anywhere the pi process can access.

All operations are parsed, paths are checked, and file changes are verified before the first write. Participating files share pi's mutation queues, acquired in a consistent order. Paths are rechecked after waiting and before mutations. For nonexistent targets beneath directory symlinks, pi's built-in tools can use a different queue key; concurrent creation through those aliases is not guaranteed to serialize across tools. If an earlier move changes a later source, the later update is matched against that source's current content.

A verification failure leaves files untouched. A failure during execution can leave partial changes; errors report completed operations, list the operations that were not applied, and identify the current target to inspect before retrying. Cancellation is checked between preparation and execution steps. An in-progress filesystem write is allowed to finish; there is no rollback.

## Failure diagnostics

When context matching fails, the error summarizes failed hunks across every file, with detailed diagnostics for up to six hunks per file. Each detailed failure reports:

- the hunk number and the line its forward search started from;
- a bounded, visibly escaped echo of the expected context lines (long contexts show first and last lines only);
- a nearby candidate window when one is found, classified as whitespace-only drift, content differences, or blank-line alignment differences;
- up to three differing line examples showing expected and actual text, the first differing column (1-based Unicode code points), character codes, and adjacent invisible-character run counts; additional differences are counted;
- inserted or missing blank lines between matching nonblank lines, with expected and actual line counts;
- an exact match that lies outside the searched range (earlier in the file, or before an `*** End of File` anchor) — usually a chunk-ordering mistake;
- whether the hunk's replacement text already occurs in the file, meaning the hunk was likely applied before;
- a context line that is a prefix of a longer source line, which usually means it was copied from truncated tool output.

Tabs, unusual spaces, zero-width characters, directional controls, and combining marks are rendered as visible Unicode escapes; ordinary spaces stay literal so that the surrounding text remains readable. These escapes are diagnostic notation; a patch must contain the literal source characters. Long line examples show an excerpt around the first difference. For example, a source with two inline spaces where the patch expects one reports:

```text
expected: "const x = 1;"
actual:   "const  x = 1;"
first difference at column 7 (Unicode code points): expected "x" (U+0078); actual SPACE (U+0020)
adjacent invisible run: expected SPACE (U+0020) × 1 at column 6; actual SPACE (U+0020) × 2 at column 6
```

Successful results carry per-hunk match details in `details`: the matched line, which comparison produced the match (exact, trailing-whitespace, whitespace, or Unicode normalization), and how many times the context occurs in the file — matching picks the first occurrence. Adds and moves that overwrite existing destinations are flagged, and a source that changed between verification and the write is rematched against its live content with a note. Candidate scans are budgeted and skipped for very large files.

Candidate discovery can collapse inline whitespace, ignore Unicode default-ignorable characters, normalize Unicode composition, and align interior blank lines. These extra comparisons are diagnostics only: they do not authorize a write or rewrite the patch. Candidate searches are bounded and may find no candidate; an error is not a guarantee that one retry will succeed.

Successful results use the Codex summary format:

```text
Success. Updated the following files:
A src/greeting.ts
M src/main.ts
D obsolete.txt
```

When a hunk's context occurs more than once in the file, or matched only after ignoring leading whitespace or normalizing Unicode punctuation, the summary appends match notes naming the file, hunk, and line so the model can verify the location and the indentation of added lines:

```text
Match notes (the patch was applied; verify these locations):
- src/main.ts hunk 2 at line 40: context occurs 3 times in the file; this occurrence was edited
```

Errors are thrown through pi's tool failure contract. In the TUI the tool row header carries the file count and the aggregate `+N/-M` (omitted when a file's previous content could not be read, so no diff exists for it); the result body lists the affected files and their diffs, cropped to the configured context and changed-line budget, with every cropped region marked by a hint line. `ctrl+o` shows the diffs whole; folded results list up to eight files at a time. Complete diff details remain in the session. RPC, print, and JSON modes receive the same plain text tool results without relying on TUI components.

## Compatibility baseline

The grammar, parser, matching passes, and fixtures are based on [OpenAI Codex `b04a2c264516ec2e6b3c91dd73ad18a21fd5a88f`](https://github.com/openai/codex/tree/b04a2c264516ec2e6b3c91dd73ad18a21fd5a88f/codex-rs/apply-patch), with the host adaptations below. Source attribution and adaptation details are in [NOTICE](./NOTICE); this package is licensed under Apache-2.0.

Updates preserve a leading BOM, unchanged context text, existing blank lines, and LF/CRLF endings as described above. These are local adaptations rather than the pinned revision's default **NormalizeToLf** behavior or its experimental `PreserveLineEndings` implementation. A trailing newline is still added to nonempty text when needed. A BOM-only result retains its BOM without adding a newline. CR-only separators are not recognized as source line boundaries.

The parser accepts upstream's lenient boundary whitespace and specific `<<EOF` wrappers, while the advertised grammar describes the normal freeform format. Empty Add operations are accepted by the parser. Empty patches and empty Update operations fail. Multi-environment `*** Environment ID:` routing is unsupported.

Workspace confinement, canonical-source duplicate detection, and rejecting non-file targets are explicit host restrictions.

## Development

From the repository root:

```bash
npm test --workspace=@d3ara1n/pi-apply-patch
npm run test:integration --workspace=@d3ara1n/pi-apply-patch
npx tsc --noEmit
```

Default tests use pure functions and an injected in-memory filesystem. Upstream fixture files are read from the repository, with explicit expectations for prevalidation and unsupported CR-only separators. Additional cases cover format preservation and diagnostic-only Unicode and whitespace comparisons. Protocol tests exercise pi's local conversion helpers without network calls.

Integration tests use temporary sandbox directories and clean them up. They exercise actual file operations, symlink boundaries, UTF-8 decoding, and shared mutation queues. They do not call a model. Live model acceptance requires loading the extension first.
