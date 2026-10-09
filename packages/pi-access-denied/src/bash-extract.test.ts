import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { posixPaths as path, windowsPaths } from "./test-paths.ts";

import {
  extractBashTargets as extract,
  extractBashTargetsDetailed as extractDetailed,
} from "./bash-extract.ts";
import { PathManager } from "./path-manager.ts";

const extractBashTargets = (command: string, cwd: string) => extract(command, cwd, path);
const extractBashTargetsDetailed = (command: string, cwd: string) =>
  extractDetailed(command, cwd, path);

// ────────────────────────────────────────────────────────────────────────────
// 2. POSIX extraction with an explicit environment
// ────────────────────────────────────────────────────────────────────────────

describe("extractBashTargets: POSIX behavior", () => {
  const CWD = "/home/me/proj";

  // ── the structural-parser win: quoted data stays whole ───────────────

  test("multi-line git commit message is NOT mined for paths", () => {
    // The whole message is a single DoubleQuoted word; the `/etc/config`,
    // `/old/data`, `/usr/local/bin` inside it are message text, not paths.
    const cmd =
      'git commit -m "feat: touch /etc/config\n\n- moved /old/data to /new/data\n- see /usr/local/bin"';
    assert.deepEqual(extractBashTargets(cmd, CWD), []);
  });

  test("single-line quoted string is not mined for paths", () => {
    assert.deepEqual(extractBashTargets('echo "see /etc/passwd for reference"', CWD), []);
  });

  test("quoted path is skipped as data (documented limitation)", () => {
    assert.deepEqual(extractBashTargets("cat '/etc/passwd'", CWD), []);
  });

  // ── nested commands recurse (the whole point of a real parser) ───────

  test("command substitution $(…) is recursed into", () => {
    assert.deepEqual(extractBashTargets("echo $(cat /etc/passwd)", CWD), ["/etc/passwd"]);
  });

  test("command substitution inside double quotes is recursed into", () => {
    // The surrounding word is data, but $(cat …) executes — must be caught.
    assert.deepEqual(extractBashTargets('echo "a$(cat /etc/passwd)b"', CWD), ["/etc/passwd"]);
  });

  test("process substitution <(…) is recursed into", () => {
    assert.deepEqual(extractBashTargets("wc <(cat /etc/passwd)", CWD), ["/etc/passwd"]);
  });

  test("subshell body is recursed into", () => {
    assert.deepEqual(extractBashTargets("(cd /tmp && rm /old/data)", CWD), [
      "/tmp",
      path.normalize("/old/data"),
    ]);
  });

  test("control-flow bodies are recursed into", () => {
    const cmd = "if [ -f /etc/x ]; then rm /tmp/y; fi";
    assert.deepEqual(extractBashTargets(cmd, CWD).sort(), ["/etc/x", "/tmp/y"]);
  });

  test("pipeline and logical chains are recursed into", () => {
    assert.deepEqual(extractBashTargets("cat /a | grep x && rm /b", CWD).sort(), [
      "/a",
      path.normalize("/b"),
    ]);
  });

  test("for-loop wordlist and body are recursed into", () => {
    const cmd = 'for f in /old/data/*; do cp "$f" /tmp; done';
    assert.deepEqual(extractBashTargets(cmd, CWD).sort(), [path.normalize("/old/data/*"), "/tmp"]);
  });

  test("unquoted heredoc command substitution IS caught", () => {
    // <<EOF (unquoted): $(rm …) executes → must be caught. Body path text is
    // not scanned, only command boundaries.
    const cmd = "cat <<EOF\nbody /etc/not-scanned\n$(rm /tmp/y)\nEOF";
    assert.deepEqual(extractBashTargets(cmd, CWD), ["/tmp/y"]);
  });

  test("quoted heredoc body is never scanned nor executed", () => {
    // <<'EOF': literal text, shell does not expand $(…). Nothing to extract.
    const cmd = "cat > /home/me/proj/out.sh <<'EOF'\n/etc/passwd\n$(rm /tmp/x)\nEOF\n";
    assert.deepEqual(extractBashTargets(cmd, CWD), ["/home/me/proj/out.sh"]);
  });

  test("assignment value is data — not scanned, but nested commands recurse", () => {
    assert.deepEqual(extractBashTargets("X=/etc/passwd", CWD), []);
    assert.deepEqual(extractBashTargets("X=~/.ssh/config", CWD), []);
    // The assignment value is data, but the $(cat …) inside it executes.
    assert.deepEqual(extractBashTargets("X=$(cat /etc/x)", CWD), ["/etc/x"]);
  });

  // ── escaped-space / backslash handling (parser dequotes `value`) ─────

  test("escaped-space path stays one token and is extracted", () => {
    assert.deepEqual(extractBashTargets("cat /Users/foo/Agent\\ Workspace/file", CWD), [
      "/Users/foo/Agent Workspace/file",
    ]);
  });

  test("escaped-space path under home is resolved and extracted", () => {
    assert.deepEqual(extractBashTargets("rm ~/My\\ Documents/secret", CWD), [
      path.join(path.home, "My Documents/secret"),
    ]);
  });

  test("multiple escaped spaces collapse into one token", () => {
    assert.deepEqual(extractBashTargets("ls /no\\ space\\ here", CWD), ["/no space here"]);
  });

  test("escaped metachar is not an escaping candidate", () => {
    assert.deepEqual(extractBashTargets("echo a\\;b", CWD), []);
  });

  test("backslash-backslash collapses to a single backslash", () => {
    assert.deepEqual(extractBashTargets("echo a\\\\b", CWD), []);
  });

  // ── operators that used to need hand-written hacks ───────────────────

  test("=~ regex-match operator does not surface a bare ~", () => {
    // `=~` is a TestBinary operator now, not a split token.
    assert.deepEqual(extractBashTargets('[[ "$s" =~ $pattern ]]', CWD), []);
  });

  // ── parent-climb (..) traversal ──────────────────────────────────────

  test("../ traversal above cwd is extracted", () => {
    const v = extractBashTargets("cat ../../../etc/passwd", CWD);
    // resolve collapses .. segments: ../../../ from /home/me/proj → /
    assert.equal(v.length, 1);
    assert.ok(v[0] === "/etc/passwd" || v[0].endsWith("/etc/passwd"));
  });

  test("embedded /../ traversal in absolute path is extracted", () => {
    assert.deepEqual(extractBashTargets("cat /home/me/proj/../other/secret", CWD), [
      path.normalize("/home/me/other/secret"),
    ]);
  });

  // ── $HOME / ${HOME} / ~ — now handled uniformly ──────────────────────

  test("${HOME} prefix is recognized as home (no longer split on braces)", () => {
    assert.deepEqual(extractBashTargets("cat ${HOME}/.ssh/config", CWD), [
      path.join(path.home, ".ssh/config"),
    ]);
  });

  test("bare ${HOME} is extracted as home-dir access", () => {
    // Consistent with `cat $HOME`: a ${HOME}/$HOME token resolves to homedir.
    assert.deepEqual(extractBashTargets("echo ${HOME}", CWD), [path.home]);
  });

  test("~otheruser is extracted as a symbolic escaping candidate", () => {
    assert.deepEqual(extractBashTargets("cat ~root/.ssh/authorized_keys", CWD), [
      "~root/.ssh/authorized_keys",
    ]);
  });

  test("bare ~otheruser (no path) is extracted as a symbolic candidate", () => {
    assert.deepEqual(extractBashTargets("echo ~root", CWD), ["~root"]);
  });

  test("~currentuser expands to the real home (equivalent to ~)", () => {
    const me = path.username;
    assert.deepEqual(extractBashTargets(`cat ~${me}/.ssh/config`, CWD), [
      path.join(path.home, ".ssh/config"),
    ]);
  });

  test("~- and ~+ (PWD/OLDPWD) are not treated as user homes", () => {
    assert.deepEqual(extractBashTargets("cat ~-/x", CWD), []);
    assert.deepEqual(extractBashTargets("cat ~+/x", CWD), []);
  });

  test("\\$HOME is unescaped and extracted as home-dir access", () => {
    assert.deepEqual(extractBashTargets("cat \\$HOME/.ssh/config", CWD), [
      path.join(path.home, ".ssh/config"),
    ]);
  });

  test("unresolved $VAR (not $HOME) is skipped", () => {
    assert.deepEqual(extractBashTargets("cat $SECRET_FILE", CWD), []);
  });

  // ── existing behavior preserved ──────────────────────────────────────

  test("unterminated heredoc swallows everything after <<EOF", () => {
    assert.deepEqual(extractBashTargets("cat > out <<EOF\n/etc/passwd\n~/secret\n", CWD), []);
  });

  test("bare absolute path is extracted", () => {
    assert.deepEqual(extractBashTargets("cat /etc/passwd", CWD), ["/etc/passwd"]);
  });

  test("relative path under cwd is left alone", () => {
    assert.deepEqual(extractBashTargets("cat src/foo.ts", CWD), []);
  });

  test("option flags are not treated as paths", () => {
    assert.deepEqual(extractBashTargets("rm -rf /etc/foo", CWD), ["/etc/foo"]);
  });

  test("heredoc opener redirect target IS extracted", () => {
    // The opener's redirect target is a real path; the body lines are stdin.
    const cmd = "cat /etc/passwd <<EOF\nbody\nEOF\n";
    assert.deepEqual(extractBashTargets(cmd, CWD), ["/etc/passwd"]);
  });

  test("safe /tmp path IS extracted as a candidate (classification is separate)", () => {
    assert.deepEqual(extractBashTargets("cat /tmp/build-out.log", CWD), ["/tmp/build-out.log"]);
  });

  test("pseudo-device IS extracted as a candidate", () => {
    assert.deepEqual(extractBashTargets("echo x > /dev/null", CWD), ["/dev/null"]);
  });

  test("/private/tmp is extracted as a candidate", () => {
    assert.deepEqual(extractBashTargets("cat /private/tmp/build-out.log", CWD), [
      "/private/tmp/build-out.log",
    ]);
  });

  test("a path under a configured allowed root IS still extracted (policy is separate)", () => {
    assert.deepEqual(extractBashTargets("cat /opt/data/x", CWD), ["/opt/data/x"]);
  });

  // ── end-to-end: extraction + PathManager classification ──────────────

  test("end-to-end: a bash command outside cwd is 'outside'", () => {
    const pm = new PathManager(CWD, [], {}, path);
    const v = extractBashTargets("cat /etc/passwd", CWD);
    assert.equal(v.length, 1);
    assert.equal(pm.decide(v[0]).kind, "outside");
  });

  test("end-to-end: a bash command touching a denied path is 'deny'", () => {
    const pm = new PathManager(CWD, [], { "/old/data": "moved to /new/data" }, path);
    const v = extractBashTargets("cat /old/data/x", CWD);
    assert.equal(pm.decide(v[0]).kind, "deny");
    assert.equal(pm.decide(v[0]).reason, "moved to /new/data");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Windows extraction with an explicit environment
//    Git Bash command strings resolved through the shared Windows API.
// ────────────────────────────────────────────────────────────────────────────

describe("extractBashTargets: Windows behavior (Git Bash / MSYS)", () => {
  const path = windowsPaths;
  const extractBashTargets = (command: string, cwd: string) => extract(command, cwd, path);
  const CWD = path.join("C:", "proj");

  test("MSYS path outside cwd is extracted in its Windows form", () => {
    const v = extractBashTargets("cat /c/Users/me/.ssh/config", CWD);
    assert.deepEqual(v, [path.join("C:", "Users", "me", ".ssh", "config")]);
  });

  test("Windows native absolute path (C:\\...) is extracted", () => {
    const nativePath = path.toNative(path.join("C:", "Users", "me", ".ssh", "config"));
    const v = extractBashTargets("cat " + nativePath, CWD);
    assert.deepEqual(v, [path.normalize(nativePath)]);
  });

  test("multi-line commit message is not mined for paths (win32)", () => {
    const cmd = 'git commit -m "see /c/old for context"';
    assert.deepEqual(extractBashTargets(cmd, CWD), []);
  });

  test("unresolved drive-relative operands do not prevent later path checks", () => {
    for (const prefix of ["echo D:file", "cd D:file"]) {
      assert.deepEqual(extractBashTargets(`${prefix}; cat /outside/file`, CWD), ["/outside/file"]);
    }
    assert.deepEqual(extractBashTargets("cd D:file", CWD), []);
  });

  test("Windows case aliases share a definite target identity", () => {
    const found = extractDetailed(
      'if check; then f=C:/Project/File; else f=c:/project/file; fi; cat "$f"',
      CWD,
      path,
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "C:/Project/File");
    assert.equal(found[0].estimate, undefined);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Leaf-command source tracking (extractBashTargetsDetailed)
//    Each path is paired with the leaf command that produced it, so the auth
//    panel can show "find /" rather than just "/".
// ────────────────────────────────────────────────────────────────────────────

describe("extractBashTargetsDetailed: leaf-command source", () => {
  const CWD = "/home/me/proj";

  test("source is the verbatim leaf command text", () => {
    const v = extractBashTargetsDetailed("find / -name '*.log'", CWD);
    assert.equal(v[0].path, "/");
    assert.equal(v[0].source, "find / -name '*.log'");
  });

  test("source distinguishes find from rm at the same path", () => {
    assert.equal(extractBashTargetsDetailed("find /", CWD)[0].source, "find /");
    assert.equal(extractBashTargetsDetailed("rm -rf /", CWD)[0].source, "rm -rf /");
  });

  test("each command in a list attributes its own paths", () => {
    const byPath = new Map(
      extractBashTargetsDetailed("find /; rm /old/data", CWD).map((t) => [t.path, t.source]),
    );
    assert.equal(byPath.get("/"), "find /");
    assert.equal(byPath.get(path.normalize("/old/data")), "rm /old/data");
  });

  test("nested command substitution keeps its own source", () => {
    const v = extractBashTargetsDetailed('echo "$(cat /etc/passwd)"', CWD);
    assert.equal(v[0].source, "cat /etc/passwd");
  });

  test("each stage of a pipeline keeps its own source", () => {
    const v = extractBashTargetsDetailed("cat /a | grep x | sort", CWD);
    assert.equal(v.find((t) => t.path === "/a")?.source, "cat /a");
  });

  test("control-flow body commands keep their own source", () => {
    const byPath = new Map(
      extractBashTargetsDetailed("if [ -f /etc/x ]; then rm /tmp/y; fi", CWD).map((t) => [
        t.path,
        t.source,
      ]),
    );
    assert.equal(byPath.get("/etc/x"), "[ -f /etc/x ]");
    assert.equal(byPath.get("/tmp/y"), "rm /tmp/y");
  });
});
