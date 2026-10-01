import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { extractBashTargetsDetailed } from "./bash-extract.ts";
import { PathManager } from "./path-manager.ts";

const CWD = path.resolve("/workspace/project");
const local = (name: string) => path.resolve(CWD, name);
const targets = (command: string, source: string) =>
  extractBashTargetsDetailed(command, CWD)
    .filter((target) => target.source === source)
    .map((target) => target.path)
    .sort();

// Expected paths follow Bash's list/shell-environment semantics. No shell
// commands, real project data, or filesystem fixtures are needed to check them.
describe("bash directory tracking", () => {
  test("a successful cd resolves a sibling inside the project", () => {
    const found = extractBashTargetsDetailed("cd aaa && rm ../bbb", CWD);
    assert.ok(
      found.some((target) => target.path === local("bbb") && target.source === "rm ../bbb"),
    );
    const pm = new PathManager(CWD, [], {});
    assert.ok(found.every((target) => pm.decide(target.path).kind === "allow"));
  });

  test("semicolon and newline retain the failed cd directory", () => {
    for (const separator of [";", "\n"]) {
      assert.deepEqual(
        targets(`cd aaa${separator} rm ../bbb`, "rm ../bbb"),
        [local("../bbb"), local("bbb")].sort(),
      );
    }
  });

  test("OR runs in the directory where cd failed", () => {
    assert.deepEqual(targets("cd aaa || rm ../bbb", "rm ../bbb"), [local("../bbb")]);
  });

  test("mixed logical chains preserve earlier successful directory changes", () => {
    assert.deepEqual(
      targets("cd aaa && cd nested || rm ../bbb", "rm ../bbb"),
      [local("../bbb"), local("bbb")].sort(),
    );
  });

  test("a terminating failure branch leaves only the successful cd", () => {
    assert.deepEqual(targets("cd aaa || exit 1; rm ../bbb", "rm ../bbb"), [local("bbb")]);
  });

  test("return and invalid exit arguments do not hide later targets", () => {
    for (const command of ["return 1", "exit 1 2"]) {
      assert.deepEqual(targets(`${command}; rm ../bbb`, "rm ../bbb"), [local("../bbb")]);
    }
  });

  test("consecutive successful changes use the updated cwd", () => {
    assert.deepEqual(targets("cd aaa && cd nested && rm ../bbb", "rm ../bbb"), [local("aaa/bbb")]);
  });

  test("a background list shares cwd internally but not with its parent", () => {
    const command = "cd aaa && rm ../inner & rm ../outer";
    assert.deepEqual(targets(command, "rm ../inner"), [local("inner")]);
    assert.deepEqual(targets(command, "rm ../outer"), [local("../outer")]);
    assert.deepEqual(targets("cd aaa & rm ../bbb", "rm ../bbb"), [local("../bbb")]);
  });

  test("subshells isolate cwd while brace groups propagate it", () => {
    assert.deepEqual(targets("(cd aaa && rm ../inner); rm ../outer", "rm ../inner"), [
      local("inner"),
    ]);
    assert.deepEqual(targets("(cd aaa); rm ../outer", "rm ../outer"), [local("../outer")]);
    assert.deepEqual(targets("{ cd aaa; } && rm ../outer", "rm ../outer"), [local("outer")]);
  });

  test("pipeline stages do not change each other's or the parent's cwd", () => {
    assert.deepEqual(targets("cd aaa | rm ../bbb; rm ../outer", "rm ../bbb"), [local("../bbb")]);
    assert.deepEqual(targets("cd aaa | cat; rm ../outer", "rm ../outer"), [local("../outer")]);
    assert.deepEqual(targets("cd aaa && { cd nested && rm ../inner; } | cat", "rm ../inner"), [
      local("aaa/inner"),
    ]);
  });

  test("negation swaps outcomes without isolating a single command", () => {
    assert.deepEqual(targets("! cd aaa || rm ../bbb", "rm ../bbb"), [local("bbb")]);
    assert.deepEqual(targets("! cd aaa && rm ../bbb", "rm ../bbb"), [local("../bbb")]);
  });

  test("substitutions inherit cwd and keep their own changes local", () => {
    for (const substitution of [
      '"$(cd nested && cat ../inner)"',
      "<(cd nested && cat ../inner)",
      "`cd nested && cat ../inner`",
      "${x:-$(cd nested && cat ../inner)}",
    ]) {
      const command = `cd aaa && echo ${substitution}; rm ../outer`;
      assert.deepEqual(targets(command, "cat ../inner"), [local("aaa/inner")]);
      assert.deepEqual(targets(command, "rm ../outer"), [local("../outer"), local("outer")].sort());
    }
  });

  test("if branches receive the condition's success and failure directories", () => {
    const command = "if cd aaa; then rm ../yes; else rm ../no; fi";
    assert.deepEqual(targets(command, "rm ../yes"), [local("yes")]);
    assert.deepEqual(targets(command, "rm ../no"), [local("../no")]);
  });

  test("quoted and escaped cd operands are directories", () => {
    for (const operand of ['"a a"', "'a a'", "a\\ a", "$'a a'"]) {
      assert.deepEqual(targets(`cd ${operand} && rm ../bbb`, "rm ../bbb"), [local("bbb")]);
    }
    assert.deepEqual(targets('cd "~" && rm ../bbb', "rm ../bbb"), [local("bbb")]);
    assert.deepEqual(targets("cd '$HOME' && rm ../bbb", "rm ../bbb"), [local("bbb")]);
  });

  test("cd home forms resolve without inspecting arbitrary quoted arguments", () => {
    for (const operand of ["", "~", '"$HOME"', '"${HOME}"']) {
      assert.deepEqual(targets(`cd ${operand} && rm ../bbb`, "rm ../bbb"), [
        path.resolve(os.homedir(), "../bbb"),
      ]);
    }
    assert.deepEqual(extractBashTargetsDetailed('echo "/outside/data"', CWD), []);
  });

  test("cd dash restores the shell-local previous directory", () => {
    assert.deepEqual(targets("cd aaa && cd nested && cd - && rm ../bbb", "rm ../bbb"), [
      local("bbb"),
    ]);
    assert.deepEqual(targets("cd - && rm ../bbb", "rm ../bbb"), []);
  });

  test("logical options, option terminators, and builtin wrappers support cd", () => {
    for (const command of ["cd -- aaa", "cd -L aaa", "builtin cd aaa", "command cd aaa"]) {
      assert.deepEqual(targets(`${command} && rm ../bbb`, "rm ../bbb"), [local("bbb")]);
    }
    assert.deepEqual(targets("command -v cd && rm ../bbb", "rm ../bbb"), [local("../bbb")]);
    assert.deepEqual(targets("cd -- -dash && rm ../bbb", "rm ../bbb"), [local("bbb")]);
  });

  test("unknown successful cd suppresses relative guesses but preserves absolute targets", () => {
    for (const operand of ['"$DEST"', '"$(getdir)"', '"${HOME:-/fallback}"', "a*", "-P aaa"]) {
      const command = `cd ${operand} && rm ../bbb; cat /known/absolute`;
      assert.deepEqual(targets(command, "rm ../bbb"), []);
      // POSIX-style absolutes stay drive-less on win32 (MSYS namespace
      // marker — builtin roots like /dev/null rely on it), so expect
      // normalize, not resolve (which would graft the process drive).
      assert.deepEqual(targets(command, "cat /known/absolute"), [path.normalize("/known/absolute")]);
    }
    assert.deepEqual(targets('cd "$DEST" || rm ../bbb', "rm ../bbb"), [local("../bbb")]);
  });

  test("an absolute cd recovers a known cwd after a dynamic change", () => {
    assert.deepEqual(targets('cd "$DEST" && cd /known/aaa && rm ../bbb', "rm ../bbb"), [
      path.resolve("/known/bbb"),
    ]);
  });

  test("unresolved cd retains existing symbolic and glob path candidates", () => {
    assert.ok(
      targets("cd ~__pi_unknown_user", "cd ~__pi_unknown_user").includes("~__pi_unknown_user"),
    );
    assert.ok(targets("cd /outside/*", "cd /outside/*").includes(path.normalize("/outside/*")));
  });

  test("cd destinations are checked even when relative or quoted", () => {
    const pm = new PathManager(CWD, [], { [local("aaa")]: "private directory" });
    const found = extractBashTargetsDetailed('cd "aaa" && true', CWD);
    assert.equal(found.length, 1);
    assert.equal(pm.decide(found[0].path).kind, "deny");
    assert.equal(found[0].source, 'cd "aaa"');
  });

  test("cd redirections resolve before the directory changes", () => {
    assert.deepEqual(
      targets("cd aaa > ../log && rm ../bbb", "cd aaa > ../log"),
      [local("../log"), local("aaa")].sort(),
    );
    assert.deepEqual(targets("cd aaa > ../log && rm ../bbb", "rm ../bbb"), [local("bbb")]);
    assert.deepEqual(targets("{ cd aaa; } > ../log && rm ../bbb", "rm ../bbb"), [local("bbb")]);
  });

  test("case branches and fallthrough preserve possible directories", () => {
    assert.deepEqual(
      targets("case x in a) cd aaa ;& b) rm ../bbb ;; esac", "rm ../bbb"),
      [local("../bbb"), local("bbb")].sort(),
    );
  });

  test("loop bodies track local cd without claiming every iteration is known", () => {
    assert.deepEqual(targets("for x in a b; do cd aaa && rm ../bbb; done", "rm ../bbb"), [
      local("bbb"),
    ]);
    assert.deepEqual(targets("while cd aaa; do rm ../bbb; done", "rm ../bbb"), [local("bbb")]);
    assert.deepEqual(targets("until cd aaa; do rm ../bbb; done", "rm ../bbb"), [local("../bbb")]);
  });

  test("defining a function does not change the surrounding cwd", () => {
    assert.deepEqual(targets("f() { cd aaa; }; rm ../bbb", "rm ../bbb"), [local("../bbb")]);
  });

  test("calling a local function invalidates directory assumptions", () => {
    const command = "f() { cd /outside; }; f && rm ../bbb; cat /known/absolute";
    assert.deepEqual(targets(command, "rm ../bbb"), []);
    assert.deepEqual(targets(command, "cat /known/absolute"), [path.normalize("/known/absolute")]);
    assert.deepEqual(targets("cd() { true; }; cd aaa && rm ../bbb", "rm ../bbb"), []);
  });

  test("static assignments update HOME, PWD, and OLDPWD without changing cwd", () => {
    for (const command of [
      'HOME=/outside; cd \"$HOME\"',
      "HOME=/outside; cd",
      'PWD=/outside; cd \"$PWD\"',
      "OLDPWD=/outside; cd -",
    ]) {
      assert.deepEqual(targets(`${command} && rm ../bbb`, "rm ../bbb"), [path.resolve("/bbb")]);
    }
    assert.deepEqual(targets("HOME=/outside; rm ../bbb", "rm ../bbb"), [local("../bbb")]);
    assert.deepEqual(targets("HOME=/outside; cat $HOME/data", "cat $HOME/data"), [
      path.normalize("/outside/data"),
    ]);
    assert.deepEqual(targets('HOME=\"$DEST\"; cd && rm ../bbb', "rm ../bbb"), []);
  });

  test("temporary HOME assignments affect implicit cd but not operand expansion", () => {
    assert.deepEqual(targets("HOME=/outside cd && rm ../bbb", "rm ../bbb"), [path.resolve("/bbb")]);
    assert.deepEqual(targets('HOME=/outside cd \"$HOME\" && rm ../bbb', "rm ../bbb"), [
      path.resolve(os.homedir(), "../bbb"),
    ]);
  });

  test("CDPATH makes searched destinations unknown while explicit paths remain usable", () => {
    assert.deepEqual(targets("CDPATH=/outside; cd aaa && rm ../bbb", "rm ../bbb"), []);
    assert.deepEqual(targets("CDPATH=/outside; cd ./aaa && rm ../bbb", "rm ../bbb"), [
      local("bbb"),
    ]);
    assert.deepEqual(targets("CDPATH=/outside; cd /known/aaa && rm ../bbb", "rm ../bbb"), [
      path.resolve("/known/bbb"),
    ]);
    assert.deepEqual(targets("CDPATH= cd aaa && rm ../bbb", "rm ../bbb"), [local("bbb")]);
  });

  test("known invalid cd options cannot execute the success branch", () => {
    assert.deepEqual(targets("cd -Z && rm /outside/bbb", "rm /outside/bbb"), []);
    assert.deepEqual(targets("cd -Z || rm ../bbb", "rm ../bbb"), [local("../bbb")]);
  });

  test("subshell and pipeline exit statuses skip unreachable branches", () => {
    for (const command of [
      "(true) || rm /outside/bbb",
      "(false) && rm /outside/bbb",
      "true | false && rm /outside/bbb",
      "false | true || rm /outside/bbb",
    ]) {
      assert.deepEqual(targets(command, "rm /outside/bbb"), []);
    }
    assert.deepEqual(targets("(exit 1) || rm ../bbb", "rm ../bbb"), [local("../bbb")]);
    assert.deepEqual(targets("true | exit 1; rm ../bbb", "rm ../bbb"), [local("../bbb")]);
    assert.deepEqual(targets("(cd aaa || exit 1) || rm ../bbb", "rm ../bbb"), [local("../bbb")]);
  });

  test("directory stack or evaluated shell code invalidates cwd", () => {
    for (const command of ["pushd aaa", "popd", "eval 'cd aaa'", "source setup.sh"]) {
      assert.deepEqual(targets(`${command} && rm ../bbb`, "rm ../bbb"), []);
    }
  });

  test("directory state does not persist across tool calls", () => {
    extractBashTargetsDetailed("cd aaa", CWD);
    assert.deepEqual(targets("rm ../bbb", "rm ../bbb"), [local("../bbb")]);
  });
});
