/**
 * Path extraction and boundary checks for pi-access-denied.
 *
 * Two sources of "targets" (paths a tool wants to touch):
 *   - write/edit: a single `path` argument — exact.
 *   - bash:       a free-form command string — heuristic tokenization.
 *
 * The bash heuristic is deliberately conservative: it only flags tokens that
 * clearly escape the project tree (absolute paths, `~`, `$HOME`, and `..`
 * traversals). Relative paths that stay under cwd (e.g. `src/foo.ts`) are left
 * alone because the shell runs inside cwd. See README "Limitations".
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * Built-in always-safe path prefixes. These never trigger a prompt:
 *   - `/dev/null`, `/dev/stdin|out|err`, `/dev/zero`, `/dev/u?random`
 *     (process-internal pseudo-devices, safe)
 *   - `/dev/fd/` (current process's own file descriptors, safe)
 *
 * `/dev/tty` is intentionally NOT included — it can capture keyboard input.
 * `/dev/disk*`, `/dev/sda*` etc. are NOT included — block devices are dangerous.
 */
const SAFE_DEV_PATHS: readonly string[] = [
	"/dev/null",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/zero",
	"/dev/urandom",
	"/dev/random",
];
const SAFE_DEV_PREFIXES: readonly string[] = ["/dev/fd/"];

/** True if `target` (normalized absolute) is an always-safe pseudo-device. */
function isSafeDevice(target: string): boolean {
	if (SAFE_DEV_PATHS.includes(target)) return true;
	return SAFE_DEV_PREFIXES.some((p) => target.startsWith(p));
}

/** Expand a leading `~` or `$HOME` form to the home directory. Returns null if not a home form. */
function expandHome(token: string): string | null {
	if (token === "~") return os.homedir();
	if (token.startsWith("~/")) return path.join(os.homedir(), token.slice(2));
	if (token === "$HOME") return os.homedir();
	if (token.startsWith("$HOME/")) return path.join(os.homedir(), token.slice(6));
	return null;
}

/** Resolve any token (absolute, home, or relative-to-cwd) to a normalized absolute path. */
export function resolveTarget(token: string, cwd: string): string {
	const home = expandHome(token);
	if (home !== null) return path.normalize(home);
	if (path.isAbsolute(token)) return path.normalize(token);
	return path.resolve(cwd, token);
}

/** Build the normalized, de-duplicated allowlist from cwd + configured extra dirs. */
export function buildAllowlist(cwd: string, extraDirs: string[]): string[] {
	const list = [path.resolve(cwd)];
	for (const d of extraDirs) {
		const home = expandHome(d) ?? d;
		const resolved = path.isAbsolute(home) ? path.normalize(home) : path.resolve(cwd, home);
		list.push(resolved);
	}
	return [...new Set(list)];
}

/** True if `target` (already normalized absolute) is NOT inside any allowlist dir. */
export function isOutsideAllowlist(target: string, allowlist: string[]): boolean {
	return !allowlist.some((dir) => target === dir || target.startsWith(dir + path.sep));
}

/**
 * True if `target` is always-safe (no prompt needed) regardless of allowlist:
 *   - built-in safe pseudo-devices (/dev/null, /dev/fd/, etc.)
 *   - the OS per-user temp dir (os.tmpdir()) when `allowTempDir`
 *   - any user-configured extra safe paths
 */
export function isSafe(target: string, opts: { allowTempDir: boolean; extraSafePaths: string[] }): boolean {
	if (isSafeDevice(target)) return true;
	if (opts.allowTempDir) {
		const tmp = path.normalize(os.tmpdir());
		if (target === tmp || target.startsWith(tmp + path.sep)) return true;
	}
	for (const p of opts.extraSafePaths) {
		const resolved = expandHome(p) ?? p;
		const norm = path.isAbsolute(resolved) ? path.normalize(resolved) : path.resolve(process.cwd(), resolved);
		if (target === norm || target.startsWith(norm + path.sep)) return true;
	}
	return false;
}

function stripQuotes(t: string): string {
	if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
		return t.slice(1, -1);
	}
	return t;
}

/** Does this token look like it could escape cwd? */
function isEscapingCandidate(token: string): boolean {
	if (token.startsWith("/")) return true; // absolute
	if (token === "~" || token.startsWith("~/")) return true; // home
	if (token === "$HOME" || token.startsWith("$HOME/")) return true; // home
	if (token === ".." || token.startsWith("../")) return true; // parent climb
	if (/\/\.\.(\/|$)/.test(token)) return true; // embedded parent: a/.. or a/../b
	return false;
}

// Shell token splitter. Separators: whitespace, quotes, and shell metachars
// `; | & < > ( ) { }`. Quoted runs are kept whole so paths with spaces survive.
const TOKEN_RE = /"[^"]*"|'[^']*'|[^\s"'`;|&<>(){}=]+/g;

/**
 * Extract the set of normalized absolute paths a bash command appears to touch
 * OUTSIDE the allowlist. Heuristic — see README for known blind spots.
 */
export function extractBashViolations(
	command: string,
	cwd: string,
	allowlist: string[],
	safeOpts: { allowTempDir: boolean; extraSafePaths: string[] },
): string[] {
	const violations = new Set<string>();
	for (const raw of command.matchAll(TOKEN_RE)) {
		const token = stripQuotes(raw[0]);
		if (!token) continue;
		if (token.startsWith("-")) continue; // option flag
		// Unresolved $VAR (other than $HOME) can't be analyzed statically — skip.
		if (token.includes("$") && !token.startsWith("$HOME")) continue;
		if (!isEscapingCandidate(token)) continue;
		const target = resolveTarget(token, cwd);
		if (isSafe(target, safeOpts)) continue; // always-safe, not a violation
		if (isOutsideAllowlist(target, allowlist)) violations.add(target);
	}
	return [...violations];
}
