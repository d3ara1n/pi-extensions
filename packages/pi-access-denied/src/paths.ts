/**
 * Shared path operations for production and tests.
 *
 * Paths use forward slashes on every host. Windows drive and UNC paths retain
 * their namespace; POSIX backslashes remain filename characters. Only this
 * module selects path dialects and reads host platform/directory defaults.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

export interface PathEnvironment {
  platform: "posix" | "win32";
  cwd: string;
  home: string;
  username: string;
  temp: string;
  /** The host's real /tmp location, when different from /tmp. */
  realTmp?: string;
  /** Known Windows per-drive working directories, keyed by drive such as "D:". */
  driveCwds?: Record<string, string>;
}

/** A path needs a working directory absent from the explicit environment. */
export class UnresolvedPathError extends Error {
  constructor(input: string) {
    super(`Cannot resolve drive-relative path without its drive's cwd: ${input}`);
    this.name = "UnresolvedPathError";
  }
}

export interface PathAPI {
  readonly platform: PathEnvironment["platform"];
  readonly cwd: string;
  readonly home: string;
  readonly username: string;
  readonly temp: string;
  normalize(input: string): string;
  join(...parts: string[]): string;
  /**
   * Resolve literal segments left to right; absolute segments replace the base.
   * Unknown drive-relative bases throw UnresolvedPathError.
   */
  resolve(...parts: string[]): string;
  /** Resolve tool/config input, including home forms and Git Bash drive paths. */
  target(input: string, cwd: string): string;
  isAbsolute(input: string): boolean;
  /** Native drive syntax interpreted by a Windows target environment. */
  isWindowsNativePath(input: string): boolean;
  root(input: string): string;
  basename(input: string): string;
  /** Canonical identity for equality, state deduplication, and map keys. */
  key(input: string): string;
  equals(a: string, b: string): boolean;
  isWithin(target: string, root: string): boolean;
  isDevice(input: string): boolean;
  safeRoots(): string[];
  /** Convert a canonical path at a native filesystem boundary. */
  toNative(input: string): string;
}

const SAFE_ROOTS = [
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/zero",
  "/dev/urandom",
  "/dev/random",
  "/dev/fd",
  "/tmp",
];
const WINDOWS_DEVICES = new Set([
  "NUL",
  "CON",
  "AUX",
  "PRN",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

class PlatformPaths implements PathAPI {
  readonly platform: PathEnvironment["platform"];
  readonly cwd: string;
  readonly home: string;
  readonly username: string;
  readonly temp: string;
  private readonly native: typeof nodePath.posix;
  private readonly realTmp?: string;
  private readonly driveCwds = new Map<string, string>();

  constructor(environment: PathEnvironment) {
    this.platform = environment.platform;
    this.native = this.platform === "win32" ? nodePath.win32 : nodePath.posix;
    this.cwd = this.normalize(environment.cwd);
    this.home = this.normalize(environment.home);
    this.username = environment.username;
    this.temp = this.normalize(environment.temp);
    this.realTmp = environment.realTmp ? this.normalize(environment.realTmp) : undefined;
    if (![this.cwd, this.home, this.temp].every((value) => this.isAbsolute(value))) {
      throw new Error("Path environment requires absolute cwd, home, and temp paths.");
    }
    for (const [drive, cwd] of Object.entries(environment.driveCwds ?? {})) {
      const normalized = this.normalize(cwd);
      if (
        !/^[A-Za-z]:$/.test(drive) ||
        this.root(normalized).toLowerCase() !== `${drive.toLowerCase()}/`
      ) {
        throw new Error(`Invalid per-drive working directory: ${drive} = ${cwd}`);
      }
      this.driveCwds.set(drive.toLowerCase(), normalized);
    }
  }

  private canonical(input: string): string {
    return this.platform === "win32" ? input.replaceAll("\\", "/") : input;
  }

  normalize(input: string): string {
    const normalized = this.native.normalize(input);
    const value = this.canonical(normalized);
    const root = this.canonical(this.native.parse(normalized).root);
    return value.length > root.length ? value.replace(/\/+$/, "") : value;
  }

  join(...parts: string[]): string {
    return this.normalize(this.native.join(...parts));
  }

  resolve(...parts: string[]): string {
    let resolved = this.cwd;
    for (const part of parts) {
      if (!part) continue;
      if (this.isAbsolute(part)) resolved = this.normalize(part);
      else if (this.platform === "win32" && /^[A-Za-z]:/.test(part)) {
        // Drive-relative input needs that drive's cwd. Never consult the host's
        // hidden per-drive environment while analyzing an explicit environment.
        const drive = part.slice(0, 2).toLowerCase();
        const base =
          drive === resolved.slice(0, 2).toLowerCase() ? resolved : this.driveCwds.get(drive);
        if (!base) throw new UnresolvedPathError(part);
        resolved = this.join(base, part.slice(2));
      } else resolved = this.join(resolved, part);
    }
    return resolved;
  }

  target(input: string, cwd: string): string {
    if (input === "~" || input === "$HOME") return this.home;
    if (input.startsWith("~/")) return this.join(this.home, input.slice(2));
    if (input.startsWith("$HOME/")) return this.join(this.home, input.slice(6));
    const user = /^~([A-Za-z_][A-Za-z0-9_-]*)(.*)$/.exec(input);
    if (user) {
      return user[1] === this.username ? this.join(this.home, user[2]) : this.normalize(input);
    }
    if (this.platform === "win32") {
      const drive = /^\/([A-Za-z])(?:\/|$)/.exec(input);
      if (drive)
        return this.normalize(`${drive[1].toUpperCase()}:/${input.slice(drive[0].length)}`);
    }
    return this.resolve(cwd, input);
  }

  isAbsolute(input: string): boolean {
    return this.native.isAbsolute(input);
  }

  isWindowsNativePath(input: string): boolean {
    return this.platform === "win32" && /^[A-Za-z]:[\\/]/.test(input);
  }

  root(input: string): string {
    return this.canonical(this.native.parse(input).root);
  }

  basename(input: string): string {
    return this.native.basename(input);
  }

  key(input: string): string {
    const normalized = this.normalize(input);
    const windowsNamespace = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
    return this.platform === "win32" && windowsNamespace ? normalized.toLowerCase() : normalized;
  }

  equals(a: string, b: string): boolean {
    return this.key(a) === this.key(b);
  }

  isWithin(target: string, root: string): boolean {
    const candidate = this.key(target);
    const parent = this.key(root);
    if (this.platform === "win32" && this.root(candidate) !== this.root(parent)) return false;
    return (
      candidate === parent || candidate.startsWith(parent.endsWith("/") ? parent : parent + "/")
    );
  }

  isDevice(input: string): boolean {
    return (
      this.platform === "win32" &&
      WINDOWS_DEVICES.has(this.basename(input).replace(/\..*$/, "").toUpperCase())
    );
  }

  safeRoots(): string[] {
    return [
      ...new Set(
        [...SAFE_ROOTS, this.temp, ...(this.realTmp ? [this.realTmp] : [])].map((root) =>
          this.normalize(root),
        ),
      ),
    ];
  }

  toNative(input: string): string {
    return this.native.normalize(input);
  }
}

/** Create the same path API for a fixed target environment without host reads. */
export function createPathAPI(environment: PathEnvironment): PathAPI {
  return new PlatformPaths(environment);
}

function hostEnvironment(): PathEnvironment {
  let username = "";
  let realTmp: string | undefined;
  const driveCwds: Record<string, string> = {};
  if (process.platform === "win32") {
    // Capture native drive defaults once, so the API itself stays deterministic.
    for (const drive of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      driveCwds[`${drive}:`] = nodePath.win32.resolve(`${drive}:.`);
    }
  }
  try {
    username = os.userInfo().username;
  } catch {
    /* Keep named homes symbolic. */
  }
  try {
    realTmp = fs.realpathSync("/tmp");
  } catch {
    /* /tmp need not exist on Windows. */
  }
  return {
    platform: process.platform === "win32" ? "win32" : "posix",
    cwd: process.cwd(),
    home: os.homedir(),
    username,
    temp: os.tmpdir(),
    realTmp,
    driveCwds,
  };
}

/** The production instance; tests may use it for real filesystem sandboxes. */
export const paths: PathAPI = createPathAPI(hostEnvironment());
