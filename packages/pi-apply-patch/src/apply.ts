import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { parsePatch } from "./core/parser.ts";
import type { FileOperation, HunkMatchInfo, HunkOutcome } from "./core/types.ts";
import { applyReplacements, planUpdate } from "./core/update.ts";
import { renderRejection, type RejectedFile } from "./report.ts";
import {
  isMissing,
  openWorkspace,
  recheckPath,
  resolveWorkspacePath,
  type PatchFileSystem,
  type Workspace,
  type WorkspacePath,
} from "./workspace.ts";

/** @internal */
export const nodeFileSystem: PatchFileSystem = {
  realpath: fs.realpath,
  lstat: fs.lstat,
  async readFile(path) {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await fs.readFile(path),
    );
  },
  async writeFile(path, content) {
    await fs.writeFile(path, content, "utf8");
  },
  async mkdir(path) {
    await fs.mkdir(path, { recursive: true });
  },
  unlink: fs.unlink,
};

export interface ApplyContext {
  readonly cwd: string;
  readonly fs: PatchFileSystem;
  readonly signal?: AbortSignal;
  readonly withFileQueue: <T>(path: string, action: () => Promise<T>) => Promise<T>;
  /** When false, patch paths outside the workspace are allowed. Defaults to true. */
  readonly workspaceOnly?: boolean;
}

export interface FileChange {
  readonly kind: FileOperation["kind"];
  readonly path: string;
  readonly moveTo?: string;
  /** Undefined when an overwritten file could not be read as UTF-8. */
  readonly before: string | undefined;
  readonly after: string;
  /** Update hunks: where and how each chunk matched. */
  readonly hunks?: readonly HunkMatchInfo[];
  /** The write replaces a file that already existed (Add over a file, or Move onto one). */
  readonly overwrites?: boolean;
  /** Source content changed between verification and write; matched against live text. */
  readonly rematched?: boolean;
}
export interface ApplyResult {
  readonly files: readonly FileChange[];
}

interface ResolvedOperation {
  operation: FileOperation;
  source: WorkspacePath;
  destination?: WorkspacePath;
}
interface PreparedChange extends ResolvedOperation {
  change: FileChange;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Patch cancelled.");
}

/** Carries per-hunk outcomes so the rejection report can list every failed chunk. */
class UnmatchedUpdateError extends Error {
  readonly outcomes: readonly HunkOutcome[];
  constructor(path: string, outcomes: readonly HunkOutcome[]) {
    super(`Failed to find expected lines in ${path}`);
    this.outcomes = outcomes;
  }
}

/** @internal */
export function formatSummary(
  files: readonly Pick<FileChange, "kind" | "path" | "moveTo" | "hunks">[],
): string {
  const rows = (
    [
      ["add", "A"],
      ["update", "M"],
      ["delete", "D"],
    ] as const
  ).flatMap(([kind, prefix]) =>
    files
      .filter((file) => file.kind === kind)
      .map((file) => `${prefix} ${file.moveTo ?? file.path}`),
  );
  const notes = files.flatMap((file) => matchNotes(file.moveTo ?? file.path, file.hunks ?? []));
  return [
    `Success. Updated the following files:\n${rows.join("\n")}`,
    ...(notes.length ? ["", "Match notes (the patch was applied; verify these locations):", ...notes] : []),
  ].join("\n");
}

/**
 * Successful matches the model may not have intended: the context also occurs
 * elsewhere, or it matched only after ignoring leading whitespace or folding
 * Unicode punctuation, so added lines keep the patch's own indentation.
 */
function matchNotes(path: string, hunks: readonly HunkMatchInfo[]): string[] {
  return hunks.flatMap((hunk) => {
    const where = `${path} hunk ${hunk.hunk} at line ${hunk.line}`;
    const notes: string[] = [];
    if (hunk.occurrences > 1)
      notes.push(`- ${where}: context occurs ${hunk.occurrences} times in the file; this occurrence was edited`);
    if (hunk.strategy === "trim" || hunk.strategy === "unicode")
      notes.push(
        `- ${where}: matched only after ${hunk.strategy === "trim" ? "ignoring leading and trailing whitespace" : "normalizing whitespace and Unicode punctuation"}; check the indentation and characters of added lines`,
      );
    return notes;
  });
}

async function verifyTarget(
  workspace: Workspace,
  target: WorkspacePath,
  optional: boolean,
): Promise<boolean> {
  await recheckPath(workspace, target);
  try {
    const stat = await workspace.fs.lstat(target.key);
    if (!stat.isFile()) throw new Error(`Patch target is not a regular file: ${target.path}`);
    return true;
  } catch (error) {
    if (optional && isMissing(error)) return false;
    throw error;
  }
}

interface SourceRead {
  readonly content: string | undefined;
  readonly existed: boolean;
}

/** Missing optional files read as empty text; unreadable ones have no text at all. */
async function readTarget(
  workspace: Workspace,
  target: WorkspacePath,
  optional: boolean,
): Promise<SourceRead> {
  const existed = await verifyTarget(workspace, target, optional);
  if (!existed) return { content: "", existed: false };
  try {
    return { content: await workspace.fs.readFile(target.path), existed: true };
  } catch (error) {
    // Codex permits overwriting files whose old contents cannot be read. The
    // optional read is for diff display, not a prerequisite for Add or Move.
    if (optional) return { content: undefined, existed: true };
    throw error;
  }
}

function matchedHunks(outcomes: readonly HunkOutcome[]): readonly HunkMatchInfo[] {
  return outcomes.flatMap((outcome) =>
    outcome.status === "matched"
      ? [
          {
            hunk: outcome.hunk,
            line: outcome.line,
            strategy: outcome.strategy,
            occurrences: outcome.occurrences,
          },
        ]
      : [],
  );
}

async function prepare(
  workspace: Workspace,
  resolved: ResolvedOperation,
  previous?: PreparedChange,
): Promise<PreparedChange> {
  const { operation, source, destination } = resolved;
  let content: string | undefined;
  let existed = true;
  try {
    ({ content, existed } = await readTarget(workspace, source, operation.kind === "add"));
  } catch (error) {
    const action =
      operation.kind === "update"
        ? "file to update"
        : operation.kind === "delete"
          ? "file to delete"
          : "file to add";
    throw new Error(`Failed to read ${action} ${source.path}: ${errorText(error)}`);
  }
  const destinationExists = destination !== undefined && (await verifyTarget(workspace, destination, true));
  if (operation.kind !== "update") {
    return {
      ...resolved,
      change: {
        kind: operation.kind,
        path: operation.path,
        before: content,
        after: operation.kind === "add" ? operation.content : "",
        ...(operation.kind === "add" && existed ? { overwrites: true } : {}),
      },
    };
  }
  const before = content!;
  let after: string;
  let hunks: readonly HunkMatchInfo[] | undefined;
  if (previous && previous.change.before === before) {
    after = previous.change.after;
    hunks = previous.change.hunks;
  } else {
    const plan = planUpdate(before, operation.chunks);
    if (plan.outcomes.some((outcome) => outcome.status === "unmatched"))
      throw new UnmatchedUpdateError(operation.path, plan.outcomes);
    after = applyReplacements(before, plan.replacements);
    hunks = matchedHunks(plan.outcomes);
  }
  return {
    ...resolved,
    change: {
      kind: "update",
      path: operation.path,
      moveTo: operation.moveTo,
      before,
      after,
      ...(hunks !== undefined && hunks.length ? { hunks } : {}),
      ...(destinationExists ? { overwrites: true } : {}),
    },
  };
}

async function withQueues<T>(
  keys: readonly string[],
  queue: ApplyContext["withFileQueue"],
  action: () => Promise<T>,
): Promise<T> {
  const enter = (index: number): Promise<T> =>
    index === keys.length ? action() : queue(keys[index], () => enter(index + 1));
  return enter(0);
}

async function writeTarget(
  workspace: Workspace,
  target: WorkspacePath,
  content: string,
): Promise<void> {
  await recheckPath(workspace, target);
  try {
    await workspace.fs.writeFile(target.path, content);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await workspace.fs.mkdir(dirname(target.path));
    await recheckPath(workspace, target);
    await workspace.fs.writeFile(target.path, content);
  }
}

/** Verify the whole patch before applying it, reporting every failed hunk. @internal */
export async function applyPatch(input: string, context: ApplyContext): Promise<ApplyResult> {
  checkAbort(context.signal);
  let workspace: Workspace;
  let resolved: ResolvedOperation[];
  try {
    const { operations } = parsePatch(input);
    if (!operations.length) throw new Error("empty patch");
    workspace = await openWorkspace(context.cwd, context.fs, context.workspaceOnly ?? true);
    resolved = [];
    const sources = new Set<string>();
    for (const operation of operations) {
      checkAbort(context.signal);
      const source = await resolveWorkspacePath(workspace, operation.path);
      if (sources.has(source.key))
        throw new Error(`invalid patch: multiple operations target ${source.path}`);
      sources.add(source.key);
      const destination =
        operation.kind === "update" && operation.moveTo !== undefined
          ? await resolveWorkspacePath(workspace, operation.moveTo)
          : undefined;
      resolved.push({ operation, source, destination });
    }
  } catch (error) {
    if (errorText(error) === "empty patch") throw new Error("patch rejected: empty patch");
    throw new Error(`apply_patch verification failed: ${errorText(error)}`);
  }

  const keys = [
    ...new Set(
      resolved.flatMap((op) => [op.source.key, ...(op.destination ? [op.destination.key] : [])]),
    ),
  ].sort();
  return withQueues(keys, context.withFileQueue, async () => {
    // Verify every operation before writing any, collecting all failures so the
    // model sees the complete rejection in one round trip.
    const prepared: PreparedChange[] = [];
    const rejected: RejectedFile[] = [];
    for (const entry of resolved) {
      checkAbort(context.signal);
      try {
        prepared.push(await prepare(workspace, entry));
      } catch (error) {
        rejected.push(
          error instanceof UnmatchedUpdateError
            ? {
                path: entry.operation.path,
                kind: entry.operation.kind,
                reason: error.message,
                outcomes: error.outcomes,
              }
            : { path: entry.operation.path, kind: entry.operation.kind, reason: errorText(error) },
        );
      }
    }
    if (rejected.length)
      throw new Error(
        renderRejection({
          rejected,
          verified: prepared.map((pending) => pending.operation.path),
        }),
      );

    const files: FileChange[] = [];
    let writesStarted = false;
    let currentPath = "";
    try {
      for (const pending of prepared) {
        currentPath = pending.destination?.path ?? pending.source.path;
        checkAbort(context.signal);
        // A preceding move can change a later source. Reuse computed content when
        // unchanged; otherwise match again against the live source, like Codex.
        const { operation, source, destination, change } = await prepare(
          workspace,
          pending,
          pending,
        );
        checkAbort(context.signal);
        writesStarted = true;
        if (operation.kind === "delete") {
          await recheckPath(workspace, source);
          await workspace.fs.unlink(source.path);
        } else {
          await writeTarget(workspace, destination ?? source, change.after);
          if (destination) {
            await recheckPath(workspace, source);
            await workspace.fs.unlink(source.path);
          }
        }
        files.push(change.before !== pending.change.before ? { ...change, rematched: true } : change);
      }
    } catch (error) {
      const partial = writesStarted
        ? `\nFilesystem changes may be partial; inspect ${currentPath} before retrying.${files.length ? `\nCompleted operations:\n${formatSummary(files).split("\n").slice(1).join("\n")}` : ""}`
        : "";
      const notApplied = prepared
        .slice(files.length)
        .map((pending) => pending.change.moveTo ?? pending.operation.path);
      const skipped = notApplied.length ? `\nNot applied: ${notApplied.join(", ")}` : "";
      throw new Error(`apply_patch failed: ${errorText(error)}${partial}${skipped}`);
    }
    return { files };
  });
}
