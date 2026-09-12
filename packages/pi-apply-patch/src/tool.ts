import { withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPatch, formatSummary, nodeFileSystem, type ApplyContext } from "./apply.ts";
import { CODEX_APPLY_PATCH_GRAMMAR } from "./grammar.ts";
import { makeDetails, renderPatchResult, type PatchDetails } from "./render.ts";

const schema = Type.Object({
  input: Type.String({
    description: "The complete patch text, from *** Begin Patch through *** End Patch.",
  }),
});

type Dependencies = Pick<ApplyContext, "fs" | "withFileQueue">;

/** @internal */
export function makeApplyPatchTool(
  dependencies: Dependencies = { fs: nodeFileSystem, withFileQueue: withFileMutationQueue },
): ToolDefinition<typeof schema, PatchDetails> {
  return {
    name: "apply_patch",
    label: "apply_patch",
    promptSnippet: "Edit workspace files with Codex-format patches",
    description:
      "Apply a Codex patch to files in the current workspace. Supports *** Add File:, *** Delete File:, *** Update File:, optional *** Move to:, @@ context markers, and *** End of File. Prefix added lines with +, removed lines with -, and context lines with a space. Relative and absolute paths must resolve within the workspace. Add and move operations can overwrite existing files. The entire patch is verified before writing; an I/O failure can leave partial changes.",
    parameters: schema,
    constrainedSampling: { type: "grammar", variants: { openai_lark: CODEX_APPLY_PATCH_GRAMMAR } },
    renderShell: "default",
    async execute(_id, { input }, signal, _onUpdate, ctx) {
      const result = await applyPatch(input, { ...dependencies, cwd: ctx.cwd, signal });
      return {
        content: [{ type: "text", text: formatSummary(result.files) }],
        details: makeDetails(result.files),
      };
    },
    renderCall(args, theme) {
      const count =
        typeof args.input === "string"
          ? [...args.input.matchAll(/^\s*\*\*\* (?:Add|Delete|Update) File: /gm)].length
          : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("apply_patch")) +
          (count ? theme.fg("dim", ` ${count} file${count === 1 ? "" : "s"}`) : ""),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("muted", "Applying patch…"), 0, 0);
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      return renderPatchResult(result.details, text, expanded, context.isError, theme);
    },
  };
}
