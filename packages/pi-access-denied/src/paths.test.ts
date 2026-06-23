/**
 * Tests for path extraction & boundary logic.
 *
 * Zero-dependency: runs on node's built-in test runner.
 *   node --test src/paths.test.ts
 *
 * Node strips TS types natively (v22.6+ with --experimental-strip-types,
 * default since v23.6), so no transpile step is needed.
 */

import { test } from "node:test";
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
	rememberAllowed,
	resolveTarget,
} from "./paths.ts";

const CWD = "/home/me/proj";
const ALLOW = buildAllowlist(CWD, []);
const SAFE = { extraSafePaths: [] as string[] };

// ── extractBashViolations: the escaped-space regression ─────────────────────

test("escaped-space path stays one token and is flagged (regression)", () => {
	// Before the fix, TOKEN_RE split on the escaped space:
	//   "/Users/foo/Agent\\" + "Workspace/file"
	// only the first token looked absolute and got flagged; the real path was lost.
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
	// `\;` used to terminate the token at the `;`. After unescape it's a literal `;`.
	// `echo a\;b` is not a path, so no violation — but it also must not produce
	// a bogus `/...` fragment.
	const v = extractBashViolations("echo a\\;b", CWD, ALLOW, SAFE);
	assert.deepEqual(v, []);
});

test("backslash-backslash collapses to a single backslash", () => {
	// `a\\b` (literal `a\b` after unescape) is not a path → no violation,
	// and must not be misread as an escape of the following char.
	const v = extractBashViolations("echo a\\\\b", CWD, ALLOW, SAFE);
	assert.deepEqual(v, []);
});

// ── extractBashViolations: existing behavior preserved ─────────────────────

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
	// `cat '/etc/passwd'` passes through — the quoted run is a data literal.
	const v = extractBashViolations("cat '/etc/passwd'", CWD, ALLOW, SAFE);
	assert.deepEqual(v, []);
});

test("heredoc body is not scanned", () => {
	const cmd = "cat > /home/me/proj/out.sh <<'EOF'\n/etc/passwd\n~/secret\nEOF\n";
	const v = extractBashViolations(cmd, CWD, ALLOW, SAFE);
	assert.deepEqual(v, []);
});

test("heredoc opener line IS scanned", () => {
	// The opener line still goes through the token scan.
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

// ── pure helpers ────────────────────────────────────────────────────────────

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
	// sibling-prefix trap: /home/me/proj2 must NOT be covered by /home/me/proj
	assert.equal(isOutsideAllowlist("/home/me/proj2", ALLOW), true);
});

test("isSafe: /tmp, /dev/null, os.tmpdir() are safe", () => {
	assert.equal(isSafe("/tmp/anything", SAFE), true);
	assert.equal(isSafe("/dev/null", SAFE), true);
	assert.equal(isSafe(path.normalize(os.tmpdir()) + "/x", SAFE), true);
	assert.equal(isSafe("/etc/passwd", SAFE), false);
});

test("coveringRoot: returns the ancestor that covers the target", () => {
	const roots = ["/a/b", "/x/y/z"];
	assert.equal(coveringRoot("/a/b/c/d", roots), "/a/b");
	assert.equal(coveringRoot("/x/y/z", roots), "/x/y/z");
	assert.equal(coveringRoot("/nope", roots), undefined);
});

test("isCoveredBy: prefix semantics across a set", () => {
	const set = new Set(["/a/b"]);
	assert.equal(isCoveredBy("/a/b", set), true);
	assert.equal(isCoveredBy("/a/b/c", set), true);
	assert.equal(isCoveredBy("/a/bc", set), false); // sibling-prefix trap
});

test("rememberAllowed: broader entry subsumes narrower ones", () => {
	const set = new Set<string>();
	rememberAllowed(set, "/a/b/c");
	rememberAllowed(set, "/a/b");
	// /a/b now covers /a/b/c, so the narrower entry should be dropped
	assert.deepEqual([...set], ["/a/b"]);
});

test("rememberAllowed: adding a child under an existing parent is a no-op", () => {
	const set = new Set<string>(["/a/b"]);
	rememberAllowed(set, "/a/b/c");
	assert.deepEqual([...set], ["/a/b"]);
});
