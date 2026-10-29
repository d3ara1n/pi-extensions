import {
  withFileMutationQueue,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPatch, formatSummary, nodeFileSystem, type ApplyContext } from "./apply.ts";
import { DEFAULT_CONFIG, type PatchConfig } from "./config.ts";
import { CODEX_APPLY_PATCH_GRAMMAR } from "./grammar.ts";
import {
  countPatchFiles,
  makeDetails,
  renderPatchHeader,
  renderPatchResult,
  renderPreviewBlock,
  summarize,
  type PatchDetails,
  type PatchSummary,
} from "./render.ts";
import { buildPreview, emptyPreviewState, type StreamPreviewState } from "./stream-preview.ts";

const schema = Type.Object({
  input: Type.String({
    description: "The complete patch text, from *** Begin Patch through *** End Patch.",
  }),
});

type Dependencies = Pick<ApplyContext, "fs" | "withFileQueue">;

/**
 * Reuse the row's call component across frames. The default shell supplies the
 * state background and horizontal padding; the Box only groups the header with
 * the preview so both travel as one component.
 */
function callComponent(state: Record<string, unknown>, last: unknown): Box {
  if (last instanceof Box) {
    state.callComponent = last;
    return last;
  }
  const cached = state.callComponent as Box | undefined;
  if (cached) return cached;
  const component = new Box(0, 0, (text) => text);
  state.callComponent = component;
  return component;
}

/** Preview rows for the patch text received so far. */
function previewRows(
  args: { input?: string },
  theme: Theme,
  cwd: string,
  state: Record<string, unknown>,
  workspaceOnly: boolean,
): string[] {
  if (typeof args.input !== "string" || args.input.length === 0) return [];
  const previewState =
    (state.previewState as StreamPreviewState | undefined) ?? emptyPreviewState();
  state.previewState = previewState;
  return buildPreview(args.input, cwd, previewState, undefined, workspaceOnly).flatMap((block) =>
    renderPreviewBlock(block, theme),
  );
}

/** @internal */
export function makeApplyPatchTool(
  dependencies: Dependencies = { fs: nodeFileSystem, withFileQueue: withFileMutationQueue },
  getConfig: () => PatchConfig = () => DEFAULT_CONFIG,
): ToolDefinition<typeof schema, PatchDetails> {
  return {
    name: "apply_patch",
    label: "apply_patch",
    promptSnippet: "Edit files with Codex-format patches",
    promptGuidelines: [
      "apply_patch format: send patch text without markdown fences, commentary, or unified-diff headers ('---', '+++', '@@ -N,M +N,M @@').",
      "Paths: use literal, unquoted paths relative to the workspace, or absolute paths. With workspaceOnly enabled (the default), paths must resolve inside the workspace. Each source file may appear only once per patch; combine its edits under one '*** Update File: path' header.",
      "Add: write '*** Add File: path', then prefix EVERY content line with '+', including blank lines (a blank line is '+'). Add overwrites an existing file; use Update for partial edits. Delete: write '*** Delete File: path' with no body.",
      "Update: write '*** Update File: path', then one or more nonempty hunks, each starting with '@@' or '@@ <existing line>'. Prefix unchanged context with one space, removed lines with '-', and added lines with '+'. These prefixes come before the original indentation. Blank lines still need their corresponding prefix. Replace text with '-' old lines followed by '+' new lines.",
      "Match current content: read the relevant source before constructing an update; reuse known current content, and re-read when it may be stale. Copy removed and context lines literally, with enough surrounding context to identify the intended occurrence. Matching selects the first match; an ambiguous snippet can edit the wrong location.",
      "Hunk order: write all hunks for a file against its content before this patch, from top to bottom, with no overlapping context. Combine nearby edits into one hunk. Later hunks search forward; they cannot match text inserted by an earlier hunk in the same update.",
      "Locators: bare '@@' searches for the hunk's context and removed lines. '@@ <existing line>' first locates that literal source line and searches AFTER it; do not repeat the locator line as the first context or removed line. To change that line itself, use bare '@@' with surrounding context, or locate an earlier line.",
      "Insertion: include unchanged context to insert at a specific location; a hunk containing only '+' lines appends to the end of the file, even with an '@@ <existing line>' locator. To match the file's final lines, put '*** End of File' after the hunk body.",
      "Move: put '*** Move to: destination' immediately after the Update header, before its hunks. A move still requires a nonempty hunk; for a rename without content changes, include an unchanged source line prefixed with a space. The destination is overwritten if it exists.",
      "Recovery: keep patches focused. Verification checks the whole patch before writing; a verification failure changes no files. Use the reported hunks and candidate context to correct the patch instead of resending it unchanged.",
      [
        "Complete apply_patch example (the Update, Move, and Delete sources must already exist with the shown context):",
        "*** Begin Patch",
        "*** Add File: greeting.txt",
        "+Hello",
        "+",
        "+Welcome",
        "*** Update File: src/main.ts",
        "@@ function greet() {",
        '-  return "Hi";',
        '+  return "Hello";',
        " }",
        "*** Update File: old-name.txt",
        "*** Move to: docs/new-name.txt",
        "@@",
        " keep this text",
        "*** Delete File: obsolete.txt",
        "*** End Patch",
      ].join("\n"),
    ],
    description:
      "Create, update, move, or delete files using a Codex-format patch. Returns a summary of changed files or failure diagnostics. Direct tool call only — not callable from codemode scripts: it is absent from the script's `tools` object.",
    parameters: schema,
    constrainedSampling: { type: "grammar", variants: { openai_lark: CODEX_APPLY_PATCH_GRAMMAR } },
    // Model-only: the tool is built around grammar-constrained patch generation by the
    // model itself; a codemode script assembling patch text would bypass that contract.
    // Scripts edit through pi's callable file tools instead.
    exposure: "model-only",
    renderShell: "default",
    async execute(_id, { input }, signal, _onUpdate, ctx) {
      const result = await applyPatch(input, {
        ...dependencies,
        cwd: ctx.cwd,
        signal,
        workspaceOnly: getConfig().workspaceOnly,
      });
      return {
        content: [{ type: "text", text: formatSummary(result.files) }],
        details: makeDetails(result.files),
      };
    },
    renderCall(args, theme, context) {
      const component = callComponent(context.state, context.lastComponent);
      // The header Text is stable: renderResult refreshes it in place once the
      // executed counts are known. Rebuilding it here would drop those counts
      // for one frame, because renderCall runs first on every pass.
      const header = (context.state.callText as Text | undefined) ?? new Text("", 0, 0);
      context.state.callText = header;
      // Parsing the input is the only source available while the patch streams in.
      const summary: PatchSummary = context.state.patchSummary ?? {
        fileCount: typeof args.input === "string" ? countPatchFiles(args.input) : 0,
      };
      header.setText(renderPatchHeader(theme, summary));

      component.clear();
      component.addChild(header);
      // History replay supplies a final result without an execution-start event.
      // Preview only while the call is pending and has no final result.
      if (!context.executionStarted && context.isPartial) {
        const rows = previewRows(
          args,
          theme,
          context.cwd,
          context.state,
          getConfig().workspaceOnly,
        );
        if (rows.length > 0) {
          component.addChild(new Text("", 0, 0));
          component.addChild(new Text(rows.join("\n"), 0, 0));
        }
      } else {
        delete context.state.previewState;
      }
      return component;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("muted", "Applying patch…"), 0, 0);
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const files =
        !context.isError && Array.isArray(result.details?.files) ? result.details.files : undefined;
      if (files) {
        const summary = summarize(files);
        const previous = context.state.patchSummary as PatchSummary | undefined;
        context.state.patchSummary = summary;
        // Refresh the header in place: lastComponent here is the result, not the
        // header. Never call context.invalidate() from a renderer — it re-enters
        // updateDisplay synchronously and the row renders twice.
        if (
          previous?.fileCount !== summary.fileCount ||
          previous?.added !== summary.added ||
          previous?.removed !== summary.removed
        )
          (context.state.callText as Text | undefined)?.setText(renderPatchHeader(theme, summary));
      }
      return renderPatchResult(result.details, text, expanded, context.isError, theme, getConfig());
    },
  };
}
