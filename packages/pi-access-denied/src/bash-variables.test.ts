import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { extractBashTargetsDetailed } from "./bash-extract.ts";
import { PathManager } from "./path-manager.ts";

const CWD = path.join(os.homedir(), "access-denied-variable-tests", "project");
const local = (value: string) => path.resolve(CWD, value);
const absolute = (value: string) => path.normalize(value);

function targets(command: string, source?: string): string[] {
  return extractBashTargetsDetailed(command, CWD)
    .filter((target) => !source || target.source === source)
    .map((target) => target.path)
    .sort();
}

describe("bash scalar variable tracking", () => {
  test("assigned references reach access policy and retain the consuming command", () => {
    for (const reference of ["$f", "${f}", '"$f"', '"${f}"']) {
      const source = `rm ${reference}`;
      const found = extractBashTargetsDetailed(`f=../private && ${source}`, CWD);
      assert.deepEqual(found, [{ path: local("../private"), source }]);
      const manager = new PathManager(CWD, [], { [local("../private")]: "private data" });
      assert.equal(manager.decide(found[0].path).kind, "deny");
    }
  });

  test("assignments and literal variable names are not file accesses", () => {
    assert.deepEqual(targets("f=../private"), []);
    assert.deepEqual(targets("f=../private; rm f"), []);
    assert.deepEqual(targets("f=../private; echo '$f'"), []);
    assert.deepEqual(targets('echo "/outside/data"'), []);
  });

  test("values compose across assignments and inside double quotes", () => {
    assert.deepEqual(targets('base=../private f=$base/file; rm "${f}.bak"'), [
      local("../private/file.bak"),
    ]);
    assert.deepEqual(targets('base="../shared files"; f=$base/file; rm "$f"'), [
      local("../shared files/file"),
    ]);
    assert.deepEqual(targets('base=~; rm "$base/file"'), [path.join(os.homedir(), "file")]);
  });

  test("empty assignments replace earlier values", () => {
    assert.deepEqual(targets('f=../private; f=; rm "$f"'), []);
  });

  test("temporary command assignments do not affect operands or later commands", () => {
    const command = 'f=../old; f=../temporary rm "$f"; cat "$f"';
    assert.deepEqual(targets(command), [local("../old")]);
    assert.deepEqual(targets('f=../temporary true; rm "$f"'), []);
  });

  test("branch values remain paired with their directory", () => {
    const command = 'if check; then cd aaa && f=../one; else f=../two; fi; rm "$f"';
    assert.deepEqual(targets(command, 'rm "$f"'), [local("one"), local("../two")].sort());
    assert.deepEqual(targets('f=../one || f=../two; rm "$f"'), [local("../one")]);
    assert.deepEqual(targets('false && f=../one; rm "$f"'), []);
  });

  test("child assignments stay local while brace groups share values", () => {
    for (const child of [
      "(f=../child)",
      "f=../child | cat",
      "f=../child &",
      'echo "$(f=../child)"',
    ]) {
      const separator = child.endsWith("&") ? " " : "; ";
      assert.deepEqual(targets(`f=../parent; ${child}${separator}rm "$f"`), [
        local("../parent"),
      ]);
    }
    assert.deepEqual(targets('f=../parent; { f=../child; }; rm "$f"'), [local("../child")]);
    assert.deepEqual(
      targets('f=../parent; echo "$(f=../child; cat "$f")"; rm "$f"'),
      [local("../child"), local("../parent")].sort(),
    );
  });

  test("relative variable values resolve where they are consumed", () => {
    assert.deepEqual(targets('f=../file; cd aaa && rm "$f"', 'rm "$f"'), [local("file")]);
    assert.deepEqual(targets('dir=aaa; cd "$dir" && rm ../file', "rm ../file"), [local("file")]);
    assert.deepEqual(targets('f=../file; cd "$unknown" && rm "$f"', 'rm "$f"'), []);
    assert.deepEqual(targets('f=/known/file; cd "$unknown" && rm "$f"', 'rm "$f"'), [
      absolute("/known/file"),
    ]);
  });

  test("references in redirects and nested commands use the current environment", () => {
    assert.deepEqual(targets('f=../file; echo ok > "$f"'), [local("../file")]);
    assert.deepEqual(targets('f=../file; echo "$(cat "$f")"'), [local("../file")]);
    assert.deepEqual(targets('f=../file; [[ -f "$f" ]]'), [local("../file")]);
    assert.deepEqual(targets('f=../file g=$(cat "$f")'), [local("../file")]);
  });

  test("stored shell syntax is literal and is never evaluated twice", () => {
    assert.deepEqual(targets('f=\'~/file\'; rm "$f"'), [local("~/file")]);
    assert.deepEqual(targets('f=\'$HOME/file\'; rm "$f"'), [local("$HOME/file")]);
    assert.deepEqual(targets('f=\'$(cat /outside/file)\'; rm "$f"'), []);
  });

  test("splitting, globbing, and complex parameter expansion remain unknown", () => {
    for (const command of [
      'f="../one ../two"; rm $f',
      'f="../files/*"; rm $f',
      'f=../one; rm "${f%one}"',
      'f=../one; IFS=/; rm $f',
    ]) assert.deepEqual(targets(command), []);
    assert.deepEqual(targets('f="../files/*"; rm "$f"'), [local("../files/*")]);
    assert.deepEqual(targets("cat $HOME/*.log"), [path.join(os.homedir(), "*.log")]);
  });

  test("unsupported assignments discard the previous scalar value", () => {
    for (const assignment of [
      "f=$unknown", "f=$(getpath)", "f+=suffix", "f=(../array)", "f[0]=../array",
    ]) assert.deepEqual(targets(`f=../old; ${assignment}; rm "$f"`, 'rm "$f"'), []);
    assert.deepEqual(targets('f=$(cat /known/input); rm "$f"'), [absolute("/known/input")]);
  });

  test("variable-mutating builtins and arithmetic discard stale values", () => {
    for (const mutation of [
      "unset f", "read f", "printf -v f value", "declare f=value", "export f=value",
      "builtin read f", "command unset f", "(( f = 1 ))", 'echo "$((f = 1))"',
      'echo "${other:=$((f = 1))}"',
      '[[ "$((f = 1))" == 1 ]]',
      'case "$((f = 1))" in *) true;; esac',
      'for x in "$((f = 1))"; do true; done',
      '{ true; } > "$((f = 1))"',
      'cmd=read; $cmd f',
    ]) assert.deepEqual(targets(`f=../old; ${mutation}; rm "$f"`, 'rm "$f"'), []);
    assert.deepEqual(targets('f=../old; printf "%s" ok; rm "$f"'), [local("../old")]);
  });

  test("array assignments invalidate arithmetic mutations to other variables", () => {
    for (const mutation of ["a[f=1]=x", 'a=("$((f=1))")']) {
      assert.deepEqual(targets(`f=../old; ${mutation}; rm "$f"`, 'rm "$f"'), []);
    }
  });

  test("wrapper options distinguish builtin invocation from command queries", () => {
    for (const wrapper of ["command -p", "command --", "builtin --", "command builtin --"]) {
      assert.deepEqual(targets(`f=../old; ${wrapper} unset f; rm "$f"`, 'rm "$f"'), []);
    }
    for (const option of ["-v", "-V", "-pv"]) {
      assert.deepEqual(targets(`f=../old; command ${option} unset; rm "$f"`), [local("../old")]);
    }
  });

  test("unknown variable mutations do not restore default splitting assumptions", () => {
    assert.deepEqual(targets("IFS=/; unset other; f=../private; rm $f"), []);
    assert.deepEqual(targets('IFS=/; unset other; f=../private; rm "$f"'), [local("../private")]);
  });

  test("empty unquoted cd expansions are omitted while quoted empty operands remain", () => {
    for (const operand of ["$dir", "${dir}", "-- $dir"]) {
      const command = `dir=; cd ${operand} && cat /known/file`;
      assert.deepEqual(targets(command, "cat /known/file"), [absolute("/known/file")]);
      assert.ok(targets(command).includes(os.homedir()));
    }
    assert.deepEqual(targets('dir=; cd "$dir" && cat /known/file'), []);
    assert.deepEqual(targets('dir=; cd $dir aaa && rm ../file', "rm ../file"), [local("file")]);
  });

  test("compound redirect mutations remain local to child shell environments", () => {
    for (const child of [
      '( : ) <<< "$((f=1))";',
      '{ :; } <<< "$((f=1))" &',
    ]) {
      assert.deepEqual(targets(`f=../old; ${child} rm "$f"`, 'rm "$f"'), [local("../old")]);
    }
    assert.deepEqual(targets('f=../old; { :; } <<< "$((f=1))"; rm "$f"', 'rm "$f"'), []);
  });

  test("loop variables never reuse a value assigned before the loop", () => {
    assert.deepEqual(
      targets('f=../old; for f in plain; do rm "$f"; done', 'rm "$f"'),
      [],
    );
    assert.deepEqual(
      targets('f=../old; for f in; do true; done; rm "$f"', 'rm "$f"'),
      [local("../old")],
    );
  });

  test("evaluated code and local function calls invalidate variable assumptions", () => {
    for (const mutation of ["eval code", "source setup.sh", "fun() { true; }; fun"]) {
      assert.deepEqual(targets(`f=../old; ${mutation}; rm "$f"`, 'rm "$f"'), []);
    }
  });

  test("variables never persist across tool calls", () => {
    targets("f=../old");
    assert.deepEqual(targets('rm "$f"'), []);
  });

  test("repeated concatenation is bounded without evaluating shell code", () => {
    const command = 'f=../file;' + 'f="$f$f";'.repeat(30) + 'rm "$f"';
    assert.deepEqual(targets(command), []);
  });
});
