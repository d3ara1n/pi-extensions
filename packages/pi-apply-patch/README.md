# pi-apply-patch

Codex-compatible `apply_patch` editing for pi, limited to the current workspace.

GPT models accustomed to Codex can use the familiar freeform patch format. The extension registers the official Lark grammar through pi's constrained sampling API and implements patch parsing, context matching, and file operations in TypeScript. It has no configuration or additional runtime library dependencies.

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

Requires pi 0.84.3 or later. After changing extension source or loading configuration, run `/reload` or restart pi.

## Dependencies

None. The extension uses the pi framework packages supplied by the host.

## Tool and transport

The tool is named `apply_patch`. Its internal schema has one required string property, `input`.

For models with `compat.supportsOpenAIGrammarTools: true`, pi advertises a freeform custom tool with the official Codex Lark grammar. The model sends patch text directly. Pi converts it to `{ input: patch }` for execution and handles custom tool result pairing and history replay.

When grammar tools are unavailable, pi advertises a function tool with the same `input` parameter. Built-in Codex models enable grammar tools; custom gateway model definitions must accurately declare this capability. A gateway must support the corresponding custom tool protocol for freeform calls to work.

This uses the Codex custom-tool protocol, not the distinct OpenAI API built-in `type: "apply_patch"` tool. Existing pi editing tools remain available. No shell command or shell-call interception is installed.

## Patch format

```diff
*** Begin Patch
*** Add File: src/greeting.ts
+export const greeting = "Hello";
*** Update File: src/main.ts
@@ function main() {
-console.log("Hi");
+console.log("Hello");
*** Update File: old-name.txt
*** Move to: docs/new-name.txt
@@
-old text
+new text
*** Delete File: obsolete.txt
*** End Patch
```

Supported operations are Add, Delete, and Update, with an optional Move destination on Update. Update chunks use space-prefixed context lines, `-` removals, and `+` additions. `@@ text` searches for a context line and continues after it; subsequent chunks search forward. `*** End of File` anchors matching to the end of the file. An update chunk containing only additions appends to the file.

Matching attempts exact text first, then ignores trailing whitespace, then leading and trailing whitespace, then normalizes selected Unicode punctuation and spaces. Each pass searches the complete remaining range before the next, looser pass. Repeated context is accepted; the first match in the successful pass wins.

Add overwrites existing files. Move writes the destination, overwriting it if necessary, then removes the source. Overwriting does not require the previous target contents to be readable as UTF-8; when an Add target cannot be read, its diff is unavailable. Missing destination directories are created. Paths are literal text, so quotes are part of a filename rather than shell quoting.

## Workspace and failure behavior

The workspace is `ctx.cwd` at execution time. Relative paths and absolute paths are accepted when both their resolved spelling and canonical location are within that workspace. Source paths, move destinations, existing symlinks, and the nearest existing ancestors of new files are checked. Dangling symlinks, non-file targets, and duplicate canonical source paths are rejected. The same boundary rule applies to Delete: a symlink pointing outside the workspace is rejected even when the operation would only unlink that symlink.

The extension performs these checks itself and does not integrate with a separate permission extension. Path checks are not an OS sandbox: they do not isolate other processes, eliminate filesystem races, or track hard-link destinations outside the workspace.

All operations are parsed, paths are checked, and file changes are verified before the first write. Participating files share pi's mutation queues, acquired in a consistent order. Paths are rechecked after waiting and before mutations. For nonexistent targets beneath directory symlinks, pi's built-in tools can use a different queue key; concurrent creation through those aliases is not guaranteed to serialize across tools. If an earlier move changes a later source, the later update is matched against that source's current content.

A verification failure leaves files untouched. A failure during execution can leave partial changes; errors report completed operations and identify the current target to inspect before retrying. Cancellation is checked between preparation and execution steps. An in-progress filesystem write is allowed to finish; there is no rollback.

Successful results use the Codex summary format:

```text
Success. Updated the following files:
A src/greeting.ts
M src/main.ts
D obsolete.txt
```

Errors are thrown through pi's tool failure contract. TUI results show file summaries and expandable diffs, with previews capped at 120 diff lines per file. Complete diff details remain in the session. RPC, print, and JSON modes receive the same plain text tool results without relying on TUI components.

## Compatibility baseline

The grammar, parsing rules, matching algorithm, and fixtures are pinned to [OpenAI Codex `b04a2c264516ec2e6b3c91dd73ad18a21fd5a88f`](https://github.com/openai/codex/tree/b04a2c264516ec2e6b3c91dd73ad18a21fd5a88f/codex-rs/apply-patch). Source attribution and adaptation details are in [NOTICE](./NOTICE); this package is licensed under Apache-2.0.

The update algorithm uses that revision's default **NormalizeToLf** mode. It adds a trailing newline to nonempty updated content when needed. Lines replaced by a chunk use LF; untouched CRLF lines may retain CRLF, so mixed endings are possible. CR-only separators are not recognized as source line boundaries. The experimental `PreserveLineEndings` mode is not enabled.

The parser accepts upstream's lenient boundary whitespace and specific `<<EOF` wrappers, while the advertised grammar describes the normal freeform format. Empty Add operations are accepted by the parser. Empty patches and empty Update operations fail. Multi-environment `*** Environment ID:` routing is unsupported.

Workspace confinement, canonical-source duplicate detection, and rejecting non-file targets are explicit host restrictions.

## Development

From the repository root:

```bash
npm test --workspace=@d3ara1n/pi-apply-patch
npm run test:integration --workspace=@d3ara1n/pi-apply-patch
npx tsc --noEmit
```

Default tests use pure functions and an injected in-memory filesystem. Upstream fixture files are read from the repository, with explicit expectations for the tool's prevalidation and the default line-ending mode. Protocol tests exercise pi's local conversion helpers without network calls.

Integration tests use temporary sandbox directories and clean them up. They exercise actual file operations, symlink boundaries, UTF-8 decoding, and shared mutation queues. They do not call a model. Live model acceptance requires loading the extension first.
