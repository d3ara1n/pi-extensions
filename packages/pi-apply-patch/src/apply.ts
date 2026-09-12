import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { parsePatch } from "./core/parser.ts";
import type { FileOperation } from "./core/types.ts";
import { applyUpdate } from "./core/update.ts";
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
}

export interface FileChange {
  readonly kind: FileOperation["kind"];
  readonly path: string;
  readonly moveTo?: string;
  /** Undefined when an overwritten file could not be read as UTF-8. */
  readonly before: string | undefined;
  readonly after: string;
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

/** @internal */
export function formatSummary(
  files: readonly Pick<FileChange, "kind" | "path" | "moveTo">[],
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
  return `Success. Updated the following files:\n${rows.join("\n")}`;
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

/** Missing optional files have empty before-text; unreadable ones have no before-text. */
async function readTarget(
  workspace: Workspace,
  target: WorkspacePath,
  optional: boolean,
): Promise<string | undefined> {
  if (!(await verifyTarget(workspace, target, optional))) return "";
  try {
    return await workspace.fs.readFile(target.path);
  } catch (error) {
    // Codex permits overwriting files whose old contents cannot be read. The
    // optional read is for diff display, not a prerequisite for Add or Move.
    if (optional) return undefined;
    throw error;
  }
}

async function prepare(
  workspace: Workspace,
  resolved: ResolvedOperation,
  previous?: PreparedChange,
): Promise<PreparedChange> {
  const { operation, source, destination } = resolved;
  let before: string | undefined;
  try {
    before = await readTarget(workspace, source, operation.kind === "add");
  } catch (error) {
    const action =
      operation.kind === "update"
        ? "file to update"
        : operation.kind === "delete"
          ? "file to delete"
          : "file to add";
    throw new Error(`Failed to read ${action} ${source.path}: ${errorText(error)}`);
  }
  if (destination) await verifyTarget(workspace, destination, true);
  const after =
    operation.kind === "delete"
      ? ""
      : operation.kind === "add"
        ? operation.content
        : previous && previous.change.before === before
          ? previous.change.after
          : applyUpdate(before!, operation.chunks, source.path);
  return {
    ...resolved,
    change: {
      kind: operation.kind,
      path: operation.path,
      moveTo: operation.kind === "update" ? operation.moveTo : undefined,
      before,
      after,
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

/** Verify the whole patch before applying it, as Codex's tool handler does. @internal */
export async function applyPatch(input: string, context: ApplyContext): Promise<ApplyResult> {
  checkAbort(context.signal);
  let workspace: Workspace;
  let resolved: ResolvedOperation[];
  try {
    const { operations } = parsePatch(input);
    if (!operations.length) throw new Error("empty patch");
    workspace = await openWorkspace(context.cwd, context.fs);
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
    const prepared: PreparedChange[] = [];
    try {
      for (const operation of resolved) {
        checkAbort(context.signal);
        prepared.push(await prepare(workspace, operation));
      }
    } catch (error) {
      throw new Error(`apply_patch verification failed: ${errorText(error)}`);
    }

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
        files.push(change);
      }
    } catch (error) {
      const partial = writesStarted
        ? `\nFilesystem changes may be partial; inspect ${currentPath} before retrying.${files.length ? `\nCompleted operations:\n${formatSummary(files).split("\n").slice(1).join("\n")}` : ""}`
        : "";
      throw new Error(`apply_patch failed: ${errorText(error)}${partial}`);
    }
    return { files };
  });
}
