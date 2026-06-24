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

// ── Platform-agnostic comparison primitives (pure, exported for testing) ─────
//
// Node's `path` module is split: `path.posix` uses `/`, `path.win32` uses `\`,
// and there is NO built-in function that treats `/dev/null` and `\dev\null` as
// equivalent. On Windows, commands coming from a Git Bash shell are written
// in MSYS style (`/dev/null`, `/tmp`, `/c/Users`), but `path.win32.normalize`
// rewrites them to `\dev\null` etc. — which then fail literal comparisons
// against Unix-style safe-path constants.
//
// We bridge that gap by normalizing the *comparison basis* to POSIX style
// (forward slashes) before matching against a single set of Unix-style
// safe-path constants. A Unix `/dev/null` and its Windows `\dev\null` alias
// both reduce to `/dev/null` and match the same constant. Windows only adds its
// own native device names (NUL/CON/...), which have no Unix analogue.
//
// These primitives are pure functions of their string inputs (no `path` module,
// no `os` calls), so win32 semantics can be unit-tested on any platform.

/** Normalize separators to POSIX `/` so `\dev\null` ≡ `/dev/null` for comparison. */
export function toPosix(p: string): string {
	// split/join avoids regex-escape pitfalls; after path.normalize() backslash
	// is the only separator Node ever emits (POSIX paths already use `/`).
	return p.includes("\\") ? p.split("\\").join("/") : p;
}

/**
 * POSIX-style prefix check (separator `/`). Pure — usable on any platform to
 * test a posix-normalized target against a posix-normalized root. Used only for
 * the safe-path constants (always posix). All other boundary checks go through
 * the separator-agnostic {@link underRoot}.
 */
export function posixUnder(posixTarget: string, posixRoot: string): boolean {
	return posixTarget === posixRoot || posixTarget.startsWith(posixRoot + "/");
}

/**
 * Windows reserved device names: NUL, CON, AUX, PRN, COM1-9, LPT1-9.
 *
 * These are Win32 device names with no Unix analogue; they are safe to write
 * (NUL is the null sink, like /dev/null). Matched by basename so `C:\proj\NUL`,
 * bare `NUL`, and `NUL.txt` are all recognized. Returns false on non-Windows.
 *
 * `platform` defaults to `process.platform`; tests inject `"win32"` to exercise
 * the logic on any host.
 */
export function isWinDeviceName(target: string, platform: string = process.platform): boolean {
	if (platform !== "win32") return false;
	// basename on a win32-normalized path yields the final segment. Strip any
	// `.<ext>` so `NUL.txt` matches (Win32 treats the bare name as the device).
	const base = path.win32.basename(target).replace(/\.[^.]*$/, "").toUpperCase();
	return WIN_DEV_NAMES.has(base);
}
const WIN_DEV_NAMES: ReadonlySet<string> = new Set([
	"NUL", "CON", "AUX", "PRN",
	"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
	"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * MSYS (Git Bash) drive notation: `/c/Users/me` → `C:\Users\me`.
 *
 * MSYS mounts Windows drives under a single-letter cygdrive prefix (case
 * insensitive). Node's `path.win32` does NOT understand this convention, so a
 * command like `ls /c/proj/src` would otherwise be mis-resolved to
 * `C:\c\proj\src` and wrongly flagged as escaping cwd `C:\proj`. Only
 * meaningful on Windows; on POSIX this returns null unconditionally.
 *
 * `platform` defaults to `process.platform`; tests inject `"win32"` to exercise
 * the logic on any host.
 */
export function msysDrive(token: string, platform: string = process.platform): string | null {
	if (platform !== "win32") return null;
	// `/x` followed by `/` or end, single letter a-z (case insensitive per MSYS).
	const m = /^\/([a-zA-Z])(\/|$)/.exec(token);
	if (!m) return null;
	const drive = m[1].toUpperCase();
	// slice past the FULL matched prefix (e.g. "/c/"), not just "/c" — otherwise
	// the leading `/` survives into `rest` and doubles up with the `:\` separator.
	const rest = token.slice(m[0].length);
	return `${drive}:\\${rest.replace(/\//g, "\\")}`;
}

/**
 * Built-in always-safe path prefixes (POSIX-form, single source of truth).
 *
 * These constants are compared in posix-normalized form (see {@link isSafe}),
 * so `/dev/null` matches both the POSIX path and the `\dev\null` alias that
 * path.win32.normalize produces. Never trigger a prompt:
 *   - `/dev/null`, `/dev/stdin|out|err`, `/dev/zero`, `/dev/u?random`
 *     (process-internal pseudo-devices, safe)
 *   - `/dev/fd/` (current process's own file descriptors, safe)
 *
 * Windows adds its own native device names (NUL/CON/...) separately via
 * {@link isWinDeviceName}, since they have no Unix path analogue.
 *
 * The gate's purpose is to prevent an out-of-control agent from leaving
 * *permanent* footprints outside the project (configs, user data, system
 * files). Task-scoped scratch space that the OS reclaims is explicitly fine:
 *   - `/tmp` (system shared, auto-cleaned; on Git Bash for Windows mounts to %TEMP%)
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

/**
 * True if `posixTarget` (posix-normalized, forward slashes) is an always-safe
 * pseudo-device. Receives a *normalized* string so the same Unix constants
 * match both `/dev/null` (POSIX) and the `\dev\null` alias produced by
 * path.win32.normalize. Call {@link toPosix} on the real target first.
 */
export function isSafeDevice(posixTarget: string): boolean {
	if (SAFE_DEV_PATHS.includes(posixTarget)) return true;
	return SAFE_DEV_PREFIXES.some((p) => posixTarget.startsWith(p));
}

/** True if `target` is under a given normalized root dir. Separator-agnostic. */
function underRoot(target: string, root: string): boolean {
	const t = toPosix(target);
	const r = toPosix(root);
	return t === r || t.startsWith(r + "/");
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
	// MSYS drive notation (/c/Users → C:\Users) must be tried before the generic
	// absolute check: path.win32 mis-resolves /c/... to C:\c\.... (no-op on POSIX.)
	const msys = msysDrive(token);
	if (msys) return path.normalize(msys);
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
	return !allowlist.some((dir) => underRoot(target, dir));
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
 *   - Windows native device names (NUL/CON/...) on win32
 *   - task-scoped scratch dirs: /tmp and os.tmpdir() (no permanent footprint)
 *   - any user-configured extra safe paths
 *
 * Comparison is done in posix-normalized form so Unix-style safe-path
 * constants match targets produced by either path.posix or path.win32.
 */
export function isSafe(target: string, opts: { extraSafePaths: string[] }): boolean {
	// Windows native device names (no Unix analogue) — matched by basename on
	// the win32 path form, before posix normalization.
	if (isWinDeviceName(target)) return true;

	// Normalize to posix so Unix constants match across platforms
	// (Windows \dev\null → /dev/null hits the same constant as the POSIX form).
	const p = toPosix(target);

	if (isSafeDevice(p)) return true;

	// /tmp and os.tmpdir(): task-scoped, OS-reclaimed, no permanent footprint.
	// posix-style prefix check so /tmp matches regardless of platform separator.
	// (On Git Bash for Windows, /tmp mounts to %TEMP% by default — see README.)
	if (posixUnder(p, "/tmp")) return true;
	if (TMP_REAL !== "/tmp" && posixUnder(p, toPosix(TMP_REAL))) return true;
	const tmp = toPosix(path.normalize(os.tmpdir()));
	if (posixUnder(p, tmp)) return true;
	for (const e of opts.extraSafePaths) {
		const resolved = expandHome(e) ?? e;
		const norm = path.isAbsolute(resolved) ? path.normalize(resolved) : path.resolve(process.cwd(), resolved);
		if (posixUnder(p, toPosix(norm))) return true;
	}
	return false;
}

function stripQuotes(t: string): string {
	if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
		return t.slice(1, -1);
	}
	return t;
}

/**
 * Strip a single backslash from every `\X` escape: `\ ` -> ` `, `\;` -> `;`, `\\` -> `\`.
 * Intended for POSIX shell escapes. Callers must first bypass it for Windows-native
 * paths (see {@link isWindowsNativePath}), whose backslashes are path separators
 * rather than escapes.
 */
function unescapeBackslash(t: string): string {
	return t.replace(/\\(.)/g, "$1");
}

const WIN_NATIVE_RE = /^[A-Za-z]:[\\/]/;

/**
 * True if `token` is a Windows-native absolute path with a drive letter
 * (`C:\Users\me`, `D:/data`). Such tokens use backslash (or, under Git Bash,
 * forward slash) as a path *separator*, not a shell escape — so they must reach
 * {@link resolveTarget} / `path.isAbsolute` with separators intact. Routing them
 * through {@link unescapeBackslash} first would collapse `C:\Users\me` to
 * `C:Usersme`, which is neither absolute nor a resolvable path, letting it slip
 * past the gate entirely.
 *
 * Pure and platform-independent: a drive-letter prefix is unambiguously
 * Windows regardless of host OS, so this is unit-testable on any platform.
 */
export function isWindowsNativePath(token: string): boolean {
	return WIN_NATIVE_RE.test(token);
}

/** Does this token look like it could escape cwd? */
function isEscapingCandidate(token: string): boolean {
	if (token.startsWith("/") || path.isAbsolute(token)) return true; // absolute (posix + windows native)
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
//
// `=` is intentionally NOT a separator: splitting there would break the bash
// regex-match operator `=~` (the `~` half would detach and be mistaken for a
// home path, expanding to $HOME) and detach assignment values (`X=/etc/passwd`
// → bare `/etc/passwd`). Escaping detection only inspects a token's PREFIX
// (`/`, `~`, `$HOME`, `..`), so an `=`-bearing token is inert unless it itself
// begins with one of those prefixes — keeping it whole can only reduce
// false positives, never create false negatives.
const TOKEN_RE = /"[^"]*"|'[^']*'|(?:\\.|[^\s"'`;|&<>(){}])+/g;

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
		const stripped = stripQuotes(r);
		if (!stripped) continue;
		// Windows-native paths (C:\...) keep backslashes as separators; any other
		// token unescapes shell backslash-escapes (\ , \;, \\, \$HOME).
		const token = isWindowsNativePath(stripped) ? stripped : unescapeBackslash(stripped);
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
