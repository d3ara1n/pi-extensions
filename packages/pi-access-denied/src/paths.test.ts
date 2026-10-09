import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PathManager } from "./path-manager.ts";
import { posixPaths, windowsPaths } from "./test-paths.ts";

for (const path of [posixPaths, windowsPaths]) {
  describe(`${path.platform} PathManager: longest-prefix-match (the core algorithm)`, () => {
    // The canonical example: a narrower rule always wins, regardless of
    // decision type or which layer it came from.
    //   allow /aaa/bbb   deny /aaa/bbb/ccc   deny /aaa
    test("the user's worked example", () => {
      const pm = new PathManager(
        "/proj",
        ["/aaa/bbb"],
        {
          "/aaa/bbb/ccc": null,
          "/aaa": null,
        },
        path,
      );
      assert.equal(pm.decide("/aaa/bbb/ddd").kind, "allow"); // allow /aaa/bbb (depth 2) beats deny /aaa (depth 1)
      assert.equal(pm.decide("/aaa/bbb/ccc/ddd").kind, "deny"); // deny /aaa/bbb/ccc (depth 3) is most specific
      assert.equal(pm.decide("/aaa/ccc").kind, "deny"); // deny /aaa (depth 1), no more specific allow
      assert.equal(pm.decide("/aaa/bbb").kind, "allow"); // exact allow rule
      assert.equal(pm.decide("/aaa/bbb/ccc").kind, "deny"); // exact deny rule
    });

    test("a sibling-prefix trap does not match", () => {
      const pm = new PathManager("/proj", ["/aaa/bbb"], {}, path);
      // /aaa/bbbccd is NOT under /aaa/bbb (must be a path separator boundary)
      assert.equal(pm.decide("/aaa/bbbccd").kind, "outside");
    });
  });

  describe(`${path.platform} PathManager: ~otheruser symbolic home rules`, () => {
    test("config allow ~otheruser/x permits a command beneath it", () => {
      const pm = new PathManager("/proj", ["~root/work"], {}, path);
      assert.equal(pm.decide("~root/work/secret").kind, "allow");
      assert.equal(pm.decide("~root/work").kind, "allow"); // exact rule
    });
    test("config deny ~otheruser blocks access beneath it", () => {
      const pm = new PathManager("/proj", [], { "~root": "other users are off-limits" }, path);
      const d = pm.decide("~root/.ssh/authorized_keys");
      assert.equal(d.kind, "deny");
      assert.equal(d.reason, "other users are off-limits");
    });
    test("uncovered ~otheruser path is 'outside' (needs authorization)", () => {
      const pm = new PathManager("/proj", [], {}, path);
      assert.equal(pm.decide("~root/anything").kind, "outside");
    });
    test("session always-allow ~otheruser overrides an uncovered path", () => {
      const pm = new PathManager("/proj", [], {}, path);
      pm.addSessionAllow("~root");
      assert.equal(pm.decide("~root/work/secret").kind, "allow");
    });
    test("~currentuser resolves to the real home, not a symbol", () => {
      const me = path.username;
      if (!me) return;
      const pm = new PathManager("/proj", [`~${me}/notes`], {}, path);
      assert.equal(pm.decide(path.join(path.home, "notes/x")).kind, "allow");
    });
  });

  describe(`${path.platform} PathManager: deny reason propagation (redirect use case)`, () => {
    test("config deny surfaces its reason to the agent", () => {
      const pm = new PathManager(
        "/proj",
        [],
        {
          "~/.config/X/data": "X 数据已迁到 ~/MyData/X，请用新位置",
        },
        path,
      );
      const home = path.home;
      const d = pm.decide(path.join(home, ".config/X/data/oldfile"));
      assert.equal(d.kind, "deny");
      assert.equal(d.reason, "X 数据已迁到 ~/MyData/X，请用新位置");
    });

    test("null reason → deny with no reason field", () => {
      const pm = new PathManager("/proj", [], { "/old/y": null }, path);
      const d = pm.decide("/old/y/sub");
      assert.equal(d.kind, "deny");
      assert.equal(d.reason, undefined);
    });

    test("empty-string reason is treated as no reason", () => {
      const pm = new PathManager("/proj", [], { "/old/z": "   " }, path);
      const d = pm.decide("/old/z");
      assert.equal(d.kind, "deny");
      assert.equal(d.reason, undefined);
    });
  });

  describe(`${path.platform} PathManager: builtin safe roots`, () => {
    const pm = new PathManager("/proj", [], {}, path);
    test("pseudo-devices are allowed", () => {
      assert.equal(pm.decide("/dev/null").kind, "allow");
      assert.equal(pm.decide("/dev/fd/3").kind, "allow");
      assert.equal(pm.decide("/dev/zero").kind, "allow");
    });
    test("/tmp and path.temp are allowed", () => {
      assert.equal(pm.decide("/tmp/anything").kind, "allow");
      assert.equal(pm.decide(path.normalize(path.temp) + "/sub/file").kind, "allow");
    });
    test("dangerous devices are NOT allowed", () => {
      assert.equal(pm.decide("/dev/tty").kind, "outside");
      assert.equal(pm.decide("/dev/sda1").kind, "outside");
    });
  });

  describe(`${path.platform} PathManager: cwd + allowedPaths`, () => {
    test("cwd and everything beneath it is allowed", () => {
      const pm = new PathManager("/home/me/proj", [], {}, path);
      assert.equal(pm.decide("/home/me/proj").kind, "allow");
      assert.equal(pm.decide("/home/me/proj/src/foo.ts").kind, "allow");
    });
    test("a root cwd covers its namespace unless a deeper deny overrides it", () => {
      const pm = new PathManager("/", [], { "/private": "blocked" }, path);
      assert.equal(pm.decide("/etc/passwd").kind, "allow");
      const denied = pm.decide("/private/data");
      assert.equal(denied.kind, "deny");
      assert.equal(denied.reason, "blocked");
    });
    test("sibling of cwd is outside (sibling-prefix trap)", () => {
      const pm = new PathManager("/home/me/proj", [], {}, path);
      assert.equal(pm.decide("/home/me/proj2").kind, "outside"); // proj2 ≠ proj/...
      assert.equal(pm.decide("/home/me/other").kind, "outside");
    });
    test("configured allowedPaths expand the boundary", () => {
      const pm = new PathManager("/proj", ["/opt/data", "~/notes"], {}, path);
      assert.equal(pm.decide("/opt/data/x").kind, "allow");
      assert.equal(pm.decide(path.join(path.home, "notes/sub")).kind, "allow");
    });
    test("an uncovered path is 'outside' (needs authorization)", () => {
      const pm = new PathManager("/proj", [], {}, path);
      assert.equal(pm.decide("/etc/passwd").kind, "outside");
    });
  });

  describe(`${path.platform} PathManager: same-depth allow/deny conflict`, () => {
    test("same path allowed AND denied → deny wins (safe default)", () => {
      // A config error (same path in both lists) resolves to deny.
      const pm = new PathManager("/proj", ["/aaa/bbb"], { "/aaa/bbb": "conflict" }, path);
      const d = pm.decide("/aaa/bbb/ccc");
      assert.equal(d.kind, "deny");
      assert.equal(d.reason, "conflict");
    });
  });

  describe(`${path.platform} PathManager: session rules override config (most specific wins)`, () => {
    test("a session allow beneath a config deny wins for that subtree", () => {
      // config deny /aaa/bbb  ·  session allow /aaa/bbb/ccc
      //   /aaa/bbb/ccc/ddd → allow (session depth 3 > config depth 2)
      //   /aaa/bbb/ddd     → deny  (config depth 2, no more specific rule)
      const pm = new PathManager("/proj", [], { "/aaa/bbb": "blocked by config" }, path);
      pm.addSessionAllow("/aaa/bbb/ccc");
      assert.equal(pm.decide("/aaa/bbb/ccc/ddd").kind, "allow");
      const d = pm.decide("/aaa/bbb/ddd");
      assert.equal(d.kind, "deny");
      assert.equal(d.reason, "blocked by config");
    });

    test("session deny with reason is cached and replayed", () => {
      const pm = new PathManager("/proj", [], {}, path);
      pm.addSessionDeny("/secret/dir", "user said no");
      const d = pm.decide("/secret/dir/deep/file");
      assert.equal(d.kind, "deny");
      assert.equal(d.reason, "user said no");
    });

    test("clearSession forgets session rules but keeps config", () => {
      const pm = new PathManager("/proj", [], { "/cfg/deny": "config reason" }, path);
      pm.addSessionAllow("/cfg/deny/sub");
      assert.equal(pm.decide("/cfg/deny/sub/x").kind, "allow"); // session overrides
      pm.clearSession();
      const d = pm.decide("/cfg/deny/sub/x");
      assert.equal(d.kind, "deny"); // back to config deny
      assert.equal(d.reason, "config reason");
    });
  });

  describe(`${path.platform} PathManager: session rule subsumption`, () => {
    test("adding a broader allow drops narrower allows beneath it", () => {
      const pm = new PathManager("/proj", [], {}, path);
      pm.addSessionAllow("/aaa/bbb/ccc");
      pm.addSessionAllow("/aaa/bbb");
      const rules = pm.getRules().session.filter((r) => r.decision === "allow");
      assert.deepEqual(
        rules.map((r) => r.path),
        ["/aaa/bbb"],
      ); // /aaa/bbb/ccc dropped
    });
    test("adding a child under an existing parent allow is a no-op", () => {
      const pm = new PathManager("/proj", [], {}, path);
      pm.addSessionAllow("/aaa/bbb");
      pm.addSessionAllow("/aaa/bbb/ccc");
      const rules = pm.getRules().session.filter((r) => r.decision === "allow");
      assert.deepEqual(
        rules.map((r) => r.path),
        ["/aaa/bbb"],
      );
    });
    test("a deny and an allow at different depths coexist (not subsumed)", () => {
      // Cross-decision rules are never dropped by subsumption — longest-prefix
      // match handles their interaction. Adding allow /aaa/bbb must NOT erase a
      // narrower deny /aaa/bbb/ccc.
      const pm = new PathManager("/proj", [], {}, path);
      pm.addSessionDeny("/aaa/bbb/ccc", "secret");
      pm.addSessionAllow("/aaa/bbb");
      assert.equal(pm.decide("/aaa/bbb/ccc/ddd").kind, "deny"); // narrower deny still wins
      assert.equal(pm.decide("/aaa/bbb/ddd").kind, "allow"); // broader allow
    });
  });
}
