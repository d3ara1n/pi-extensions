/**
 * Tests for path extraction & boundary logic.
 *
 * Zero-dependency: runs on node's built-in test runner.
 *   node --test src/paths.test.ts
 *
 * Node strips TS types natively (v22.6+ with --experimental-strip-types,
 * default since v23.6), so no transpile step is needed.
 *
 * ## Test layering
 *
 * The suite is split into three groups so CI matrix (linux/macos/windows)
 * actually exercises the right behavior per platform:
 *
 * 1. **Cross-platform pure functions** — run on ALL platforms. These test
 *    platform-agnostic helpers (toPosix, posixUnder, …) and the injected-
 *    platform variants of isWinDeviceName / msysDrive, so Windows logic can be
 *    verified on any host by passing `platform: "win32"`.
 *
 * 2. **POSIX behavior** — skipped on win32. Uses a POSIX cwd/allowlist and
 *    asserts POSIX-shaped results. Covers the original heuristic + helpers.
 *
 * 3. **Windows behavior** — skipped on non-win32. Exercises the full resolve →
 *    isSafe → isOutsideAllowlist chain under the real `path.win32` module
 *    (Git Bash / MSYS path conventions). This is the only place the MSYS drive
 *    translation and `/dev/null`→`\dev\null` normalization are validated end
 *    to end — they cannot be tested on a POSIX host because the global `path`
 *    module is locked to posix at startup.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildAllowlist,
	coveringRoot,
	extractBashViolations,
	isCoveredBy,
	isOutsideAllowlist,
	isSafe,
	isSafeDevice,
	isWinDeviceName,
	msysDrive,
	posixUnder,
	rememberAllowed,
	rememberDenied,
	resolveTarget,
	toPosix,
} from "./paths.ts";

// Skip helpers: a truthy value becomes the skip reason shown in the report.
const SKIP_POSIX: true | undefined = process.platform === "win32" ? true : undefined;
const SKIP_WIN32: true | undefined = process.platform !== "win32" ? true : undefined;

// ────────────────────────────────────────────────────────────────────────────
// 1. Cross-platform pure functions (run everywhere)
// ────────────────────────────────────────────────────────────────────────────

describe("toPosix: separator normalization", () => {
	test("backslash form reduces to posix form", () => {
		assert.equal(toPosix("\\dev\\null"), "/dev/null");
		assert.equal(toPosix("\\tmp\\x"), "/tmp/x");
		assert.equal(toPosix("\\dev\\fd\\3"), "/dev/fd/3");
	});
	test("posix form is unchanged", () => {
		assert.equal(toPosix("/dev/null"), "/dev/null");
		assert.equal(toPosix("/tmp/x"), "/tmp/x");
	});
	test("windows drive paths get forward slashes", () => {
		assert.equal(toPosix("C:\\Users\\me"), "C:/Users/me");
	});
	test("string without backslashes is returned as-is", () => {
		assert.equal(toPosix("plain/path"), "plain/path");
		assert.equal(toPosix(""), "");
	});
});

describe("posixUnder: posix-style prefix check", () => {
	test("child path is under root", () => {
		assert.equal(posixUnder("/tmp/x", "/tmp"), true);
		assert.equal(posixUnder("/tmp/deep/nested", "/tmp"), true);
	});
	test("equal path is under root", () => {
		assert.equal(posixUnder("/tmp", "/tmp"), true);
	});
	test("sibling-prefix trap: /tmp2 is NOT under /tmp", () => {
		assert.equal(posixUnder("/tmp2", "/tmp"), false);
		assert.equal(posixUnder("/tm", "/tmp"), false);
	});
});

describe("isSafeDevice: pseudo-device recognition (posix-normalized input)", () => {
	test("exact safe devices", () => {
		assert.equal(isSafeDevice("/dev/null"), true);
		assert.equal(isSafeDevice("/dev/stdin"), true);
		assert.equal(isSafeDevice("/dev/stdout"), true);
		assert.equal(isSafeDevice("/dev/stderr"), true);
		assert.equal(isSafeDevice("/dev/zero"), true);
		assert.equal(isSafeDevice("/dev/urandom"), true);
		assert.equal(isSafeDevice("/dev/random"), true);
	});
	test("/dev/fd/ prefix (process file descriptors)", () => {
		assert.equal(isSafeDevice("/dev/fd/0"), true);
		assert.equal(isSafeDevice("/dev/fd/3"), true);
		assert.equal(isSafeDevice("/dev/fd/99"), true);
	});
	test("non-devices are not safe", () => {
		assert.equal(isSafeDevice("/etc/passwd"), false);
		assert.equal(isSafeDevice("/tmp/x"), false); // /tmp is handled by isSafe, not isSafeDevice
		assert.equal(isSafeDevice("/dev/tty"), false); // intentionally excluded
		assert.equal(isSafeDevice("/dev/sda1"), false); // block device, excluded
	});
});

describe("isWinDeviceName: Windows reserved device names", () => {
	// Inject platform: "win32" lets us verify Windows logic on any host.
	test("NUL recognized in all positions", () => {
		assert.equal(isWinDeviceName("NUL", "win32"), true);
		assert.equal(isWinDeviceName("nul", "win32"), true); // case insensitive
		assert.equal(isWinDeviceName("C:\\proj\\NUL", "win32"), true); // under a path
		assert.equal(isWinDeviceName("NUL.txt", "win32"), true); // with extension
	});
	test("other reserved names", () => {
		assert.equal(isWinDeviceName("CON", "win32"), true);
		assert.equal(isWinDeviceName("AUX", "win32"), true);
		assert.equal(isWinDeviceName("PRN", "win32"), true);
		assert.equal(isWinDeviceName("COM1", "win32"), true);
		assert.equal(isWinDeviceName("COM9", "win32"), true);
		assert.equal(isWinDeviceName("LPT1", "win32"), true);
		assert.equal(isWinDeviceName("LPT9", "win32"), true);
	});
	test("ordinary files are not devices", () => {
		assert.equal(isWinDeviceName("C:\\proj\\file.txt", "win32"), false);
		assert.equal(isWinDeviceName("output.log", "win32"), false);
		assert.equal(isWinDeviceName("NULLVALUE", "win32"), false); // not an exact device name
	});
	test("returns false on non-win32 platforms", () => {
		assert.equal(isWinDeviceName("NUL", "darwin"), false);
		assert.equal(isWinDeviceName("NUL", "linux"), false);
	});
	test("defaults to process.platform (no-op on posix host)", () => {
		// On this host (posix CI), the default sees a non-win32 platform → false.
		assert.equal(isWinDeviceName("NUL"), process.platform === "win32");
	});
});

describe("msysDrive: Git Bash drive notation", () => {
	test("single-letter drive resolves to Windows form", () => {
		// path.win32.join used to build the expected value avoids hand-writing
		// backslashes that are easy to get wrong in source.
		assert.equal(msysDrive("/c/Users/me", "win32"), path.win32.join("C:\\Users", "me"));
		assert.equal(msysDrive("/c/proj/src", "win32"), path.win32.join("C:\\proj", "src"));
		assert.equal(msysDrive("/d/data", "win32"), path.win32.join("D:\\data"));
	});
	test("case insensitive (MSYS is posix=0)", () => {
		assert.equal(msysDrive("/C/Users", "win32"), path.win32.join("C:\\Users"));
		assert.equal(msysDrive("/E/foo", "win32"), path.win32.join("E:\\foo"));
	});
	test("bare drive (no trailing path)", () => {
		assert.equal(msysDrive("/c", "win32"), "C:\\");
	});
	test("MSYS built-in paths are NOT drives", () => {
		// /etc, /usr, /tmp, /dev, /var, /bin, /opt — multi-letter or special,
		// the `/x/` or `/x$` pattern does not match (the char after the letter
		// is another letter, not a separator).
		assert.equal(msysDrive("/etc/passwd", "win32"), null);
		assert.equal(msysDrive("/usr/bin", "win32"), null);
		assert.equal(msysDrive("/tmp/x", "win32"), null);
		assert.equal(msysDrive("/dev/null", "win32"), null);
		assert.equal(msysDrive("/var/log", "win32"), null);
		assert.equal(msysDrive("/bin/sh", "win32"), null);
		assert.equal(msysDrive("/opt/home", "win32"), null);
	});
	test("returns null on non-win32 platforms", () => {
		assert.equal(msysDrive("/c/Users/me", "darwin"), null);
		assert.equal(msysDrive("/c/Users/me", "linux"), null);
	});
	test("defaults to process.platform", () => {
		assert.equal(msysDrive("/c/Users/me"), process.platform === "win32" ? path.win32.join("C:\\Users", "me") : null);
	});
});

describe("coveringRoot / isCoveredBy: prefix semantics", () => {
	test("coveringRoot returns the ancestor that covers the target", () => {
		const roots = ["/a/b", "/x/y/z"];
		assert.equal(coveringRoot("/a/b/c/d", roots), "/a/b");
		assert.equal(coveringRoot("/x/y/z", roots), "/x/y/z");
		assert.equal(coveringRoot("/nope", roots), undefined);
	});
	test("isCoveredBy prefix semantics across a set", () => {
		const set = new Set(["/a/b"]);
		assert.equal(isCoveredBy("/a/b", set), true);
		assert.equal(isCoveredBy("/a/b/c", set), true);
		assert.equal(isCoveredBy("/a/bc", set), false); // sibling-prefix trap
	});
});

describe("rememberAllowed / rememberDenied: memory compaction", () => {
	test("rememberAllowed: broader entry subsumes narrower ones", () => {
		const set = new Set<string>();
		rememberAllowed(set, "/a/b/c");
		rememberAllowed(set, "/a/b");
		assert.deepEqual([...set], ["/a/b"]); // /a/b/c dropped
	});
	test("rememberAllowed: adding a child under an existing parent is a no-op", () => {
		const set = new Set<string>(["/a/b"]);
		rememberAllowed(set, "/a/b/c");
		assert.deepEqual([...set], ["/a/b"]);
	});
	test("rememberDenied: mirror behavior with reasons", () => {
		const map = new Map<string, string>();
		rememberDenied(map, "/a/b/c", "secret");
		rememberDenied(map, "/a/b", "broader");
		assert.deepEqual([...map.entries()], [["/a/b", "broader"]]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// 2. POSIX behavior (skipped on win32)
//    Uses a POSIX cwd/allowlist; asserts POSIX-shaped results.
// ────────────────────────────────────────────────────────────────────────────

describe(
	"POSIX behavior",
	{ skip: SKIP_POSIX },
	() => {
		const CWD = "/home/me/proj";
		const ALLOW = buildAllowlist(CWD, []);
		const SAFE = { extraSafePaths: [] as string[] };

		// ── extractBashViolations: the escaped-space regression ─────────────

		test("escaped-space path stays one token and is flagged (regression)", () => {
			const v = extractBashViolations("cat /Users/foo/Agent\\ Workspace/file", CWD, ALLOW, SAFE);
			assert.deepEqual(v, ["/Users/foo/Agent Workspace/file"]);
		});

		test("escaped-space path under home is resolved and flagged", () => {
			const v = extractBashViolations("rm ~/My\\ Documents/secret", CWD, ALLOW, SAFE);
			assert.deepEqual(v, [path.join(os.homedir(), "My Documents/secret")]);
		});

		test("multiple escaped spaces collapse into one token", () => {
			const v = extractBashViolations("ls /no\\ space\\ here", CWD, ALLOW, SAFE);
			assert.deepEqual(v, ["/no space here"]);
		});

		test("escaped metachar does not split the token", () => {
			const v = extractBashViolations("echo a\\;b", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("backslash-backslash collapses to a single backslash", () => {
			const v = extractBashViolations("echo a\\\\b", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		// ── extractBashViolations: existing behavior preserved ─────────────

		test("bare absolute path outside allowlist is flagged", () => {
			const v = extractBashViolations("cat /etc/passwd", CWD, ALLOW, SAFE);
			assert.deepEqual(v, ["/etc/passwd"]);
		});

		test("relative path under cwd is left alone", () => {
			const v = extractBashViolations("cat src/foo.ts", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("option flags are not treated as paths", () => {
			const v = extractBashViolations("rm -rf /etc/foo", CWD, ALLOW, SAFE);
			assert.deepEqual(v, ["/etc/foo"]);
		});

		test("quoted path is skipped as data (documented limitation)", () => {
			const v = extractBashViolations("cat '/etc/passwd'", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("heredoc body is not scanned", () => {
			const cmd = "cat > /home/me/proj/out.sh <<'EOF'\n/etc/passwd\n~/secret\nEOF\n";
			const v = extractBashViolations(cmd, CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("heredoc opener line IS scanned", () => {
			const cmd = "cat /etc/passwd <<EOF\nbody\nEOF\n";
			const v = extractBashViolations(cmd, CWD, ALLOW, SAFE);
			assert.deepEqual(v, ["/etc/passwd"]);
		});

		test("unresolved $VAR (not $HOME) is skipped", () => {
			const v = extractBashViolations("cat $SECRET_FILE", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("safe /tmp path does not trigger", () => {
			const v = extractBashViolations("cat /tmp/build-out.log", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("safe pseudo-device does not trigger", () => {
			const v = extractBashViolations("echo x > /dev/null", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("extraSafePaths suppress a configured prefix", () => {
			const v = extractBashViolations(
				"cat /var/log/myapp/x.log",
				CWD,
				ALLOW,
				{ extraSafePaths: ["/var/log/myapp"] },
			);
			assert.deepEqual(v, []);
		});

		test("extraAllowedDirs expand the boundary", () => {
			const allow = buildAllowlist(CWD, ["/opt/data"]);
			const v = extractBashViolations("cat /opt/data/x", CWD, allow, SAFE);
			assert.deepEqual(v, []);
		});

		// ── resolveTarget & boundary helpers ───────────────────────────────

		test("resolveTarget: absolute passes through normalized", () => {
			assert.equal(resolveTarget("/a/b/../c", CWD), path.normalize("/a/c"));
		});

		test("resolveTarget: ~ expands to homedir", () => {
			assert.equal(resolveTarget("~/x", CWD), path.join(os.homedir(), "x"));
			assert.equal(resolveTarget("~", CWD), os.homedir());
		});

		test("resolveTarget: relative resolves against cwd", () => {
			assert.equal(resolveTarget("src/foo.ts", CWD), path.join(CWD, "src/foo.ts"));
		});

		test("isOutsideAllowlist: ancestor prefix is in-bounds", () => {
			assert.equal(isOutsideAllowlist("/home/me/proj", ALLOW), false);
			assert.equal(isOutsideAllowlist("/home/me/proj/src/x", ALLOW), false);
			assert.equal(isOutsideAllowlist("/home/me/other", ALLOW), true);
			assert.equal(isOutsideAllowlist("/home/me/proj2", ALLOW), true); // sibling-prefix trap
		});

		test("isSafe: /tmp, /dev/null, os.tmpdir() are safe", () => {
			assert.equal(isSafe("/tmp/anything", SAFE), true);
			assert.equal(isSafe("/dev/null", SAFE), true);
			assert.equal(isSafe(path.normalize(os.tmpdir()) + "/x", SAFE), true);
			assert.equal(isSafe("/etc/passwd", SAFE), false);
		});
	},
);

// ────────────────────────────────────────────────────────────────────────────
// 3. Windows behavior (skipped on non-win32)
//    Exercises the full chain under the real path.win32 module — the only
//    place MSYS drive translation and backslash normalization are validated
//    end to end. Expected values are built with path.win32.* to avoid
//    hand-writing backslashes that drift out of sync.
// ────────────────────────────────────────────────────────────────────────────

describe(
	"Windows behavior (Git Bash / MSYS)",
	{ skip: SKIP_WIN32 },
	() => {
		const CWD = path.win32.join("C:", "proj");
		const ALLOW = buildAllowlist(CWD, []);
		const SAFE = { extraSafePaths: [] as string[] };

		// ── resolveTarget: MSYS drive translation ──────────────────────────

		test("MSYS drive /c/... resolves to the Windows drive", () => {
			assert.equal(resolveTarget("/c/proj/src", CWD), path.win32.join("C:", "proj", "src"));
			assert.equal(resolveTarget("/d/data", CWD), path.win32.join("D:", "data"));
		});

		test("MSYS drive is case insensitive", () => {
			assert.equal(resolveTarget("/E/foo", CWD), path.win32.join("E:", "foo"));
		});

		test("bare /dev/null is not mistaken for a drive (no E: mapping)", () => {
			// /dev/null → /d is followed by 'e', not '/', so it is not a drive.
			// It resolves to a win32-normalized absolute path, not "D:\\ev\\null".
			const resolved = resolveTarget("/dev/null", CWD);
			assert.ok(
				!resolved.startsWith(path.win32.join("D:", "ev")),
				`/dev/null must not resolve to a D: drive path, got: ${resolved}`,
			);
		});

		// ── isSafe: backslash normalization + Windows devices ─────────────

		test("/dev/null is recognized as safe after win32 normalization", () => {
			// path.win32.normalize("/dev/null") → "\dev\null", which toPosix
			// reduces back to /dev/null and matches the safe-device constant.
			const resolved = resolveTarget("/dev/null", CWD);
			assert.equal(isSafe(resolved, SAFE), true);
		});

		test("/tmp is recognized as safe (Git Bash mounts it to %TEMP%)", () => {
			const resolved = resolveTarget("/tmp/build.log", CWD);
			assert.equal(isSafe(resolved, SAFE), true);
		});

		test("/dev/fd/N is recognized as safe", () => {
			const resolved = resolveTarget("/dev/fd/3", CWD);
			assert.equal(isSafe(resolved, SAFE), true);
		});

		test("Windows native NUL device is safe", () => {
			assert.equal(isSafe("NUL", SAFE), true);
			assert.equal(isSafe(path.win32.join(CWD, "NUL"), SAFE), true); // C:\proj\NUL
			assert.equal(isSafe("NUL.txt", SAFE), true);
		});

		test("os.tmpdir() (%TEMP%) is safe", () => {
			const tmpFile = path.win32.join(os.tmpdir(), "sub", "file");
			assert.equal(isSafe(tmpFile, SAFE), true);
		});

		test("a real external path is NOT safe", () => {
			assert.equal(isSafe(path.win32.join("C:", "Windows", "System32", "config.sys"), SAFE), false);
		});

		// ── extractBashViolations: Git Bash command strings ───────────────

		test("redirect to /dev/null does not flag", () => {
			const v = extractBashViolations("git clone url 2>/dev/null", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("write to /tmp does not flag", () => {
			const v = extractBashViolations("echo x > /tmp/build.log", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("MSYS path under cwd (/c/proj/...) is in-bounds", () => {
			const v = extractBashViolations("cat /c/proj/src/foo.ts", CWD, ALLOW, SAFE);
			assert.deepEqual(v, []);
		});

		test("MSYS path outside cwd (/c/Users/...) is flagged with its Windows form", () => {
			const v = extractBashViolations("cat /c/Users/me/.ssh/config", CWD, ALLOW, SAFE);
			assert.deepEqual(v, [path.win32.join("C:", "Users", "me", ".ssh", "config")]);
		});

		test("extraAllowedDirs (Windows roots) expand the boundary", () => {
			const allow = buildAllowlist(CWD, [path.win32.join("D:", "shared")]);
			const v = extractBashViolations("cat /d/shared/data.bin", CWD, allow, SAFE);
			assert.deepEqual(v, []);
		});

		// ── boundary helpers under win32 ──────────────────────────────────

		test("isOutsideAllowlist: Windows prefix semantics", () => {
			assert.equal(isOutsideAllowlist(path.win32.join(CWD, "src"), ALLOW), false);
			assert.equal(isOutsideAllowlist(CWD, ALLOW), false);
			assert.equal(isOutsideAllowlist(path.win32.join("C:", "other"), ALLOW), true);
		});
	},
);
