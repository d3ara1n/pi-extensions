/**
 * Path primitives + bash target extraction for pi-access-denied.
 *
 * This module is PURE: no policy, no decision logic. It owns two concerns:
 *
 *   1. **Path normalization primitives** — separator-agnostic comparison
 *      (toPosix/underRoot), home expansion, MSYS drive translation, Windows
 *      device-name detection. These are the building blocks the PathManager
 *      (path-manager.ts) uses to compare a target against its rule set.
 *
 *   2. **bash target extraction** — given a free-form command string, recover
 *      the absolute paths it appears to touch OUTSIDE the cwd (absolute
 *      paths, `~`, `$HOME`, and `..` traversals). This is a deliberately
 *      conservative heuristic (see README "Limitations"); it does NOT decide
 *      whether those paths are allowed — that is the PathManager's job.
 *
 * The old allowlist/safe/remember helpers lived here too, but they encoded
 * POLICY (what's safe, what's outside, what's remembered). They have been
 * collapsed into the PathManager's single longest-prefix-match `decide()`,
 * so there is now exactly one place that decides access.
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
 * test a posix-normalized target against a posix-normalized root.
 */
export function posixUnder(posixTarget: string, posixRoot: string): boolean {
	return posixTarget === posixRoot || posixTarget.startsWith(posixRoot + "/");
}

/**
 * True if `target` equals or sits beneath `root`. Separator-agnostic: both
 * sides are normalized to POSIX first, so `/a/b` and `C:\proj` style roots
 * both work. Used by the PathManager for prefix matching.
 */
export function underRoot(target: string, root: string): boolean {
	const t = toPosix(target);
	const r = toPosix(root);
	return t === r || t.startsWith(r + "/");
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

// ── Built-in always-safe roots ──────────────────────────────────────────────
//
// The gate's purpose is to prevent an out-of-control agent from leaving
// *permanent* footprints outside the project (configs, user data, system
// files). Task-scoped scratch space that the OS reclaims is explicitly fine:
//   - `/dev/null`, `/dev/stdin|out|err`, `/dev/zero`, `/dev/u?random`
//     (process-internal pseudo-devices, safe)
//   - `/dev/fd/` (current process's own file descriptors, safe)
//   - `/tmp` (system shared, auto-cleaned; on Git Bash for Windows mounts to %TEMP%)
//   - `os.tmpdir()` (per-user temp, auto-cleaned; on Linux it == /tmp)
//
// `/dev/tty` is intentionally NOT included — it can capture keyboard input.
// `/dev/disk*`, `/dev/sda*` etc. are NOT included — block devices are dangerous.
//
// These become the PathManager's "builtin" allow rules. Windows native device
// names (NUL/CON/...) are handled separately by {@link isWinDeviceName} since
// they are matched by basename, not by prefix.

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
 * The always-safe root paths (POSIX-normalized) that never trigger an
 * authorization prompt, regardless of the allowlist: pseudo-devices, process
 * file descriptors, and OS-reclaimed scratch dirs. The PathManager turns
 * these into its "builtin" allow rules. Pure of policy beyond this fixed set.
 */
export function builtinSafeRoots(): string[] {
	const roots: string[] = [
		...SAFE_DEV_PATHS,
		...SAFE_DEV_PREFIXES.map((p) => p.replace(/\/$/, "")), // "/dev/fd/" → "/dev/fd"
		"/tmp",
	];
	// macOS /tmp → /private/tmp symlink: the real path must also be safe.
	if (TMP_REAL !== "/tmp") roots.push(TMP_REAL);
	roots.push(path.normalize(os.tmpdir()));
	// Normalize every entry to POSIX so cross-platform prefix matching works
	// (e.g. win32 os.tmpdir() → "C:\...\Temp" → "C:/.../Temp").
	return [...new Set(roots.map(toPosix))];
}

// ── Path resolution ─────────────────────────────────────────────────────────

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

// ── bash target extraction (pure syntax; NO policy) ─────────────────────────
//
// A bash command is an arbitrary shell string, so perfect static path analysis
// is impossible. The extractor flags tokens that CLEARLY escape the project
// tree (absolute paths, `~`, `$HOME`, and `..` traversals). Relative paths
// that stay under cwd (e.g. `src/foo.ts`) are left alone because the shell
// runs inside cwd. See README "Limitations" for known blind spots.
//
// The extractor does NOT decide whether a flagged path is allowed/denied —
// it merely returns the resolved candidate paths. Classification is the
// PathManager's job, so policy lives in exactly one place.

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
 * Scan a single command line's tokens for escaping-path candidates and add
 * their resolved absolute form to `targets`. Shared by the per-line loop in
 * {@link extractBashTargets}.
 *
 * Quoted tokens are **skipped**: a quoted run is a data literal passed to a
 * program (e.g. `echo '...'`, `sed 's|a|b|g'`, `printf '%s' ...`), not a path
 * the command opens. Treating such literals as paths was the root cause of
 * code-content false positives — e.g. a JS block comment at the start of a
 * quoted string was mistaken for absolute path `/`.
 */
function scanLine(line: string, cwd: string, targets: Set<string>): void {
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
		targets.add(resolveTarget(token, cwd));
	}
}

/** If `line` opens a heredoc (`<<DELIM` forms), return the bare delimiter word. */
function heredocDelim(line: string): string | null {
	const m = line.match(HEREDOC_RE);
	return m ? m[1] : null;
}

/**
 * Extract the de-duplicated set of normalized absolute paths a bash command
 * APPEARS to reach OUTSIDE cwd. Heuristic — see README for known blind spots.
 *
 * This is PURE EXTRACTION: it returns every escaping-looking candidate without
 * judging whether it is allowed or denied. The caller (index.ts) runs each
 * result through `PathManager.decide()` to classify it. Keeping extraction and
 * policy separate means the tokenizing heuristic and the access rules can each
 * evolve without entangling the other.
 *
 * Processes the command **line by line** so it can skip heredoc bodies: a line
 * that opens `<<DELIM` flips on body-skipping until the matching `DELIM`
 * terminator line. Inside the body, lines are stdin data, not paths. This is
 * what stops a `cat > f <<'EOF' ... code ... EOF` from flagging every
 * `/...` token in the embedded code.
 */
export function extractBashTargets(command: string, cwd: string): string[] {
	const targets = new Set<string>();
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
		scanLine(line, cwd, targets);
	}
	return [...targets];
}
