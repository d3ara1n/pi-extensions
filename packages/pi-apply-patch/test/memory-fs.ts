import { dirname, parse, relative, resolve, sep } from "node:path";
import type { ApplyContext } from "../src/apply.ts";
import type { PatchFileSystem } from "../src/workspace.ts";

export const ROOT = resolve("/patch-workspace");
export function ioError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

/** Deterministic filesystem for default tests; no disk or user state is touched. */
export class MemoryFileSystem implements PatchFileSystem {
  files = new Map<string, string>();
  dirs = new Set<string>();
  links = new Map<string, string>();
  writes: string[] = [];
  beforeWrite?: (path: string) => void;
  beforeUnlink?: (path: string) => void;

  constructor(initial: Record<string, string> = {}) {
    this.addDir(ROOT);
    for (const [path, content] of Object.entries(initial)) {
      const absolute = resolve(ROOT, path);
      this.addDir(dirname(absolute));
      this.files.set(absolute, content);
    }
  }
  addDir(path: string): void {
    this.dirs.add(path);
    const parent = dirname(path);
    if (parent !== path) this.addDir(parent);
  }
  private follow(input: string, final = true, depth = 0): string {
    if (depth > 40) throw ioError("ELOOP", input);
    const absolute = resolve(ROOT, input);
    const root = parse(absolute).root;
    const segments = absolute.slice(root.length).split(sep).filter(Boolean);
    let current = root;
    for (const [index, part] of segments.entries()) {
      current = resolve(current, part);
      const link = this.links.get(current);
      if (link !== undefined && (final || index < segments.length - 1)) {
        return this.follow(
          resolve(dirname(current), link, ...segments.slice(index + 1)),
          final,
          depth + 1,
        );
      }
      if (index < segments.length - 1 && !this.dirs.has(current))
        throw ioError(this.files.has(current) ? "ENOTDIR" : "ENOENT", current);
    }
    return current;
  }
  async realpath(path: string): Promise<string> {
    const key = this.follow(path);
    if (!this.files.has(key) && !this.dirs.has(key)) throw ioError("ENOENT", path);
    return key;
  }
  async lstat(path: string) {
    const key = this.follow(path, false);
    if (!this.files.has(key) && !this.dirs.has(key) && !this.links.has(key))
      throw ioError("ENOENT", path);
    return {
      isFile: () => this.files.has(key),
      isDirectory: () => this.dirs.has(key),
      isSymbolicLink: () => this.links.has(key),
    };
  }
  async readFile(path: string): Promise<string> {
    const key = await this.realpath(path);
    if (!this.files.has(key)) throw ioError("EISDIR", path);
    return this.files.get(key)!;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.beforeWrite?.(path);
    const key = this.follow(path);
    if (!this.dirs.has(dirname(key))) throw ioError("ENOENT", dirname(key));
    if (this.dirs.has(key)) throw ioError("EISDIR", key);
    this.files.set(key, content);
    this.writes.push(`write ${key}`);
  }
  async mkdir(path: string): Promise<void> {
    const absolute = resolve(ROOT, path);
    let current = parse(absolute).root;
    for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
      current = this.follow(resolve(current, part));
      if (this.files.has(current)) throw ioError("ENOTDIR", current);
      this.dirs.add(current);
    }
  }
  async unlink(path: string): Promise<void> {
    this.beforeUnlink?.(path);
    const key = this.follow(path, false);
    if (!this.files.delete(key) && !this.links.delete(key)) throw ioError("ENOENT", key);
    this.writes.push(`delete ${key}`);
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(
      [...this.files]
        .map(([path, content]) => [relative(ROOT, path).split(sep).join("/"), content])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  context(overrides: Partial<ApplyContext> = {}): ApplyContext {
    return { cwd: ROOT, fs: this, withFileQueue: async (_path, action) => action(), ...overrides };
  }
}
