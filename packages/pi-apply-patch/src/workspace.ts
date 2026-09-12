import { dirname, isAbsolute, relative, resolve } from "node:path";

/** The filesystem boundary used by patch preparation and execution. */
export interface PatchFileSystem {
  realpath(path: string): Promise<string>;
  lstat(
    path: string,
  ): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface Workspace {
  readonly cwd: string;
  readonly root: string;
  readonly fs: PatchFileSystem;
}

export interface WorkspacePath {
  /** Absolute spelling used for filesystem operations, preserving symlink semantics. */
  readonly path: string;
  /** Canonical path used for boundary checks and mutation queue deduplication. */
  readonly key: string;
}

/** @internal */
export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" ||
    (suffix !== ".." &&
      !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(suffix))
  );
}

/** @internal */
export async function openWorkspace(cwd: string, fs: PatchFileSystem): Promise<Workspace> {
  return { cwd: resolve(cwd), root: await fs.realpath(cwd), fs };
}

/** Resolve nonexistent leaves through their nearest existing, non-dangling ancestor. */
async function canonicalPath(path: string, fs: PatchFileSystem): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Dangling symbolic link: ${path}`);
    } catch (statError) {
      if (!isMissing(statError)) throw statError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalPath(parent, fs), relative(parent, path));
  }
}

/** @internal */
export async function resolveWorkspacePath(
  workspace: Workspace,
  input: string,
): Promise<WorkspacePath> {
  if (!input || input.includes("\0"))
    throw new Error("Patch paths must be nonempty and contain no NUL characters.");
  const path = resolve(workspace.cwd, input);
  if (!within(path, workspace.cwd) && !within(path, workspace.root)) {
    throw new Error(`Path is outside the workspace: ${input}`);
  }
  const key = await canonicalPath(path, workspace.fs);
  if (!within(key, workspace.root))
    throw new Error(`Path resolves outside the workspace: ${input}`);
  if (key === workspace.root) throw new Error(`Patch target is the workspace directory: ${input}`);
  return { path, key };
}

/** Recheck after queue waits and before each write to catch changed path resolution. @internal */
export async function recheckPath(workspace: Workspace, target: WorkspacePath): Promise<void> {
  const current = await resolveWorkspacePath(workspace, target.path);
  if (current.key !== target.key)
    throw new Error(`Path changed while applying patch: ${target.path}`);
}
