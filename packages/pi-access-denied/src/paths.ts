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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Built-in always-safe path prefixes. These never trigger a prompt:
 *   - `/dev/null`, `/dev/stdin|out|err`, `/dev/zero`, `/dev/u?random`
 *     (process-internal pseudo-devices, safe)
 *   - `/dev/fd/` (current process's own file descriptors, safe)
 *
 * The gate's purpose is to prevent an out-of-control agent from leaving
 * *permanent* footprints outside the project (configs, user data, system
 * files). Task-scoped scratch space that the OS reclaims is explicitly fine:
 *   - `/tmp` (system shared, auto-cleaned)
 *   - `os.tmpdir()` (per-user temp, auto-cleaned; on Linux it == /tmp)
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

/** Resolve `/tmp` to its real path (handles the macOS `private/tmp` symlink). */
const TMP_REAL = (() => {
	try {
		return fs.realpathSync("/tmp");
	} catch {
		return "/tmp";
	}
})();

/** True if `target` (normalized absolute) is an always-safe pseudo-device. */
function isSafeDevice(target: string): boolean {
	if (SAFE_DEV_PATHS.includes(target)) return true;
	return SAFE_DEV_PREFIXES.some((p) => target.startsWith(p));
}

/** True if `target` is under a given normalized root dir. */
function underRoot(target: string, root: string): boolean {
	return target === root || target.startsWith(root + path.sep);
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
 * Return the entry in `roots` that covers `target` (equals it or is one of its
 * ancestors), or undefined if none. Lets a caller both *test* coverage and
 * recover the covering root — e.g. to look up the reason attached to a deny
 * root. Mirrors `underRoot` but across a set.
 */
export function coveringRoot(target: string, roots: Iterable<string>): string | undefined {
	for (const r of roots) {
		if (underRoot(target, r)) return r;
	}
	return undefined;
}

/** True if `target` equals or sits beneath any entry in `roots` (prefix match). */
export function isCoveredBy(target: string, roots: Iterable<string>): boolean {
	return coveringRoot(target, roots) !== undefined;
}

/**
 * Remember `dir` as an always-allow root with prefix semantics:
 *   - if some remembered root already covers `dir`, do nothing (redundant);
 *   - otherwise drop any remembered roots that sit *beneath* `dir` (they are
 *     now subsumed by the broader entry) and add `dir`.
 *
 * This keeps the set minimal and the status view free of odd “parent listed
 * next to its own child” duplication.
 */
export function rememberAllowed(set: Set<string>, dir: string): void {
	if (isCoveredBy(dir, set)) return; // a parent already covers dir
	for (const existing of [...set]) {
		if (existing !== dir && underRoot(existing, dir)) set.delete(existing);
	}
	set.add(dir);
}

/**
 * Mirror of {@link rememberAllowed} for the deny map (path → reason): keeps the
 * widest deny, drops narrower denies subsumed by the new `dir`.
 */
export function rememberDenied(map: Map<string, string>, dir: string, reason: string): void {
	if (isCoveredBy(dir, map.keys())) return; // a parent already denies dir
	for (const existing of [...map.keys()]) {
		if (existing !== dir && underRoot(existing, dir)) map.delete(existing);
	}
	map.set(dir, reason);
}

/**
 * True if `target` is always-safe (no prompt needed) regardless of allowlist:
 *   - built-in safe pseudo-devices (/dev/null, /dev/fd/, etc.)
 *   - task-scoped scratch dirs: /tmp and os.tmpdir() (no permanent footprint)
 *   - any user-configured extra safe paths
 */
export function isSafe(target: string, opts: { extraSafePaths: string[] }): boolean {
	if (isSafeDevice(target)) return true;
	// /tmp and os.tmpdir(): task-scoped, OS-reclaimed, no permanent footprint.
	// Match both the literal "/tmp" prefix and its realpath (macOS: /tmp -> /private/tmp)
	// so LLM-provided paths like "/tmp/foo" are recognized without a realpath round-trip.
	if (underRoot(target, "/tmp")) return true;
	if (TMP_REAL !== "/tmp" && underRoot(target, TMP_REAL)) return true;
	const tmp = path.normalize(os.tmpdir());
	if (underRoot(target, tmp)) return true;
	for (const p of opts.extraSafePaths) {
		const resolved = expandHome(p) ?? p;
		const norm = path.isAbsolute(resolved) ? path.normalize(resolved) : path.resolve(process.cwd(), resolved);
		if (underRoot(target, norm)) return true;
	}
	return false;
}

function stripQuotes(t: string): string {
	if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
		return t.slice(1, -1);
	}
	return t;
}

/** Strip a single backslash from every `\X` escape: `\ ` -> ` `, `\;` -> `;`, `\\` -> `\`. */
function unescapeBackslash(t: string): string {
	return t.replace(/\\(.)/g, "$1");
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
// A backslash escape (`\X`) is consumed inside a token via the `\\.` branch, so
// `/a/Agent\ Workspace/b` stays ONE token instead of splitting on the escaped
// space. The escape is later stripped by {@link unescapeBackslash}.
const TOKEN_RE = /"[^"]*"|'[^']*'|(?:\\.|[^\s"'`;|&<>(){}=])+/g;

// Heredoc opener: `<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`, `<<\DELIM`.
// Captures the bare delimiter word (quotes/escape stripped) so we can find the
// matching terminator line and skip the body. Here-strings (`<<<`) don't match
// because the third `<` fails the `[A-Za-z_]` start requirement.
const HEREDOC_RE = /<<-?\s*(?:\\|["']?)([A-Za-z_][\w-]*)["']?/;

/**
 * Scan a single command line's tokens for out-of-allowlist paths. Mutates
 * `violations`. Shared by the per-line loop in {@link extractBashViolations}.
 *
 * Quoted tokens are **skipped**: a quoted run is a data literal passed to a
 * program (e.g. `echo '...'`, `sed 's|a|b|g'`, `printf '%s' ...`), not a path
 * the command opens. Treating such literals as paths was the root cause of
 * code-content false positives — e.g. a JS block comment at the start of a
 * quoted string was mistaken for absolute path `/`.
 */
function scanLine(
	line: string,
	cwd: string,
	allowlist: string[],
	safeOpts: { extraSafePaths: string[] },
	violations: Set<string>,
): void {
	for (const raw of line.matchAll(TOKEN_RE)) {
		const r = raw[0];
		// Quoted run = data literal, not a path. See method comment.
		if (r[0] === '"' || r[0] === "'") continue;
		const token = unescapeBackslash(stripQuotes(r));
		if (!token) continue;
		if (token.startsWith("-")) continue; // option flag
		// Unresolved $VAR (other than $HOME) can't be analyzed statically — skip.
		if (token.includes("$") && !token.startsWith("$HOME")) continue;
		if (!isEscapingCandidate(token)) continue;
		const target = resolveTarget(token, cwd);
		if (isSafe(target, safeOpts)) continue; // always-safe, not a violation
		if (isOutsideAllowlist(target, allowlist)) violations.add(target);
	}
}

/** If `line` opens a heredoc (`<<DELIM` forms), return the bare delimiter word. */
function heredocDelim(line: string): string | null {
	const m = line.match(HEREDOC_RE);
	return m ? m[1] : null;
}

/**
 * Extract the set of normalized absolute paths a bash command appears to touch
 * OUTSIDE the allowlist. Heuristic — see README for known blind spots.
 *
 * Processes the command **line by line** so it can skip heredoc bodies: a line
 * that opens `<<DELIM` flips on body-skipping until the matching `DELIM`
 * terminator line. Inside the body, lines are stdin data, not paths. This is
 * what stops a `cat > f <<'EOF' ... code ... EOF` from flagging every
 * `/...` token in the embedded code.
 */
export function extractBashViolations(
	command: string,
	cwd: string,
	allowlist: string[],
	safeOpts: { extraSafePaths: string[] },
): string[] {
	const violations = new Set<string>();
	let pendingDelim: string | null = null;
	for (const line of command.split("\n")) {
		if (pendingDelim !== null) {
			// Heredoc body: stdin data, never a path. Terminated by a line equal to
			// the delimiter; `<<-` permits leading tabs, so strip those before compare.
			if (line.replace(/^\t+/, "").trim() === pendingDelim) pendingDelim = null;
			continue;
		}
		const delim = heredocDelim(line);
		if (delim) pendingDelim = delim;
		scanLine(line, cwd, allowlist, safeOpts, violations);
	}
	return [...violations];
}
