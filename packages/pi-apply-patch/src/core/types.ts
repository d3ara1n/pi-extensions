/** A Codex update chunk using the default NormalizeToLf representation. */
export interface Chunk {
  readonly anchor?: string;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly endOfFile: boolean;
}

export type FileOperation =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly moveTo?: string;
      readonly chunks: readonly Chunk[];
    };

export interface ParsedPatch {
  readonly operations: readonly FileOperation[];
}
