import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { normalizePatchInput, type NormalizedPatch } from "./core/normalize.ts";
import { fileWarnings, PatchApplicationError, withNotices, type PatchNotice } from "./notices.ts";
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
  readonly notices: readonly PatchNotice[];
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
  files: readonly Pick<
    FileChange,
    "kind" | "path" | "moveTo" | "hunks" | "overwrites" | "rematched"
  >[],
  notices: readonly PatchNotice[] = files.flatMap(fileWarnings),
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
  return withNotices(`Success. Updated the following files:\n${rows.join("\n")}`, notices);
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

/**
 * Simulated state of one path after the operations earlier in the patch touched
 * it. Later operations read this instead of the disk, mirroring Codex's
 * sequential read-modify-write per operation.
 */
interface PriorState {
  readonly exists: boolean;
  readonly content: string;
}

async function prepare(
  workspace: Workspace,
  resolved: ResolvedOperation,
  previous?: PreparedChange,
  prior?: PriorState,
  destinationPrior?: PriorState,
): Promise<PreparedChange> {
  const { operation, source, destination } = resolved;
  let content: string | undefined;
  let existed = true;
  if (prior) {
    // Verification runs against the simulated state earlier operations left
    // behind, so the disk is only read when this is the first operation on the
    // path. Write-time matching re-reads the live file either way.
    if (prior.exists) {
      content = prior.content;
      existed = true;
    } else if (operation.kind === "add") {
      content = "";
      existed = false;
    } else {
      const action = operation.kind === "update" ? "file to update" : "file to delete";
      throw new Error(
        `Failed to read ${action} ${source.path}: removed by an earlier operation in this patch`,
      );
    }
  } else {
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
  }
  const destinationExists = destination
    ? destinationPrior
      ? destinationPrior.exists
      : await verifyTarget(workspace, destination, true)
    : false;
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

/** Normalize once, then verify the entire patch before writing. @internal */
export async function applyPatch(input: string, context: ApplyContext): Promise<ApplyResult> {
  checkAbort(context.signal);
  const normalized = normalizePatchInput(input);
  const notices = [...normalized.notices];
  try {
    return await applyCanonicalPatch(normalized, context, notices);
  } catch (error) {
    throw new PatchApplicationError(error, notices);
  }
}

async function applyCanonicalPatch(
  normalized: NormalizedPatch,
  context: ApplyContext,
  notices: PatchNotice[],
): Promise<ApplyResult> {
  checkAbort(context.signal);
  let workspace: Workspace;
  let resolved: ResolvedOperation[];
  try {
    const { operations } = parsePatch(normalized.input, normalized.sourceLines);
    if (!operations.length) throw new Error("empty patch");
    workspace = await openWorkspace(context.cwd, context.fs, context.workspaceOnly ?? true);
    resolved = [];
    for (const operation of operations) {
      checkAbort(context.signal);
      const source = await resolveWorkspacePath(workspace, operation.path);
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
    // model sees the complete rejection in one round trip. Operations sharing a
    // path verify sequentially: each sees the content the earlier ones leave
    // behind, matching Codex's per-operation read-modify-write order.
    const prepared: PreparedChange[] = [];
    const rejected: RejectedFile[] = [];
    const simulated = new Map<string, PriorState>();
    for (const entry of resolved) {
      checkAbort(context.signal);
      try {
        const change = await prepare(
          workspace,
          entry,
          undefined,
          simulated.get(entry.source.key),
          entry.destination ? simulated.get(entry.destination.key) : undefined,
        );
        prepared.push(change);
        const { operation } = entry;
        if (operation.kind === "delete") {
          simulated.set(entry.source.key, { exists: false, content: "" });
        } else if (operation.kind === "update" && operation.moveTo !== undefined) {
          simulated.set(entry.source.key, { exists: false, content: "" });
          if (entry.destination)
            simulated.set(entry.destination.key, { exists: true, content: change.change.after });
        } else {
          simulated.set(entry.source.key, { exists: true, content: change.change.after });
        }
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
        const completed =
          change.before !== pending.change.before ? { ...change, rematched: true } : change;
        files.push(completed);
        notices.push(...fileWarnings(completed));
      }
    } catch (error) {
      const partial = writesStarted
        ? `\nFilesystem changes may be partial; inspect ${currentPath} before retrying.${files.length ? `\nCompleted operations:\n${formatSummary(files, []).split("\n").slice(1).join("\n")}` : ""}`
        : "";
      const notApplied = prepared
        .slice(files.length)
        .map((pending) => pending.change.moveTo ?? pending.operation.path);
      const skipped = notApplied.length ? `\nNot applied: ${notApplied.join(", ")}` : "";
      throw new Error(`apply_patch failed: ${errorText(error)}${partial}${skipped}`);
    }
    return { files, notices };
  });
}
