import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPathAPI } from "./paths.ts";
import { posixPaths, windowsPaths } from "./test-paths.ts";

for (const { paths, home, temp } of [
  { paths: posixPaths, home: "/home/test-user", temp: "/temporary" },
  { paths: windowsPaths, home: "C:/Users/test-user", temp: "C:/Temp" },
]) {
  describe(`shared path API (${paths.platform})`, () => {
    test("normalizes segments and trailing separators to one stable representation", () => {
      assert.equal(paths.normalize("/outside/./nested/../file/"), "/outside/file");
      assert.equal(paths.normalize("/"), "/");
      assert.equal(paths.join("/outside", "nested", "..", "file"), "/outside/file");
      assert.equal(paths.resolve("/project", "../shared/file"), "/shared/file");
      assert.equal(paths.resolve("/project", "/outside/file"), "/outside/file");
      assert.equal(paths.resolve("/project", "src", "../file"), "/project/file");
    });

    test("home expansion is explicit and literal resolution does not expand stored syntax", () => {
      assert.equal(paths.home, home);
      assert.equal(paths.username, "test-user");
      assert.equal(paths.target("~", "/project"), home);
      assert.equal(paths.target("$HOME", "/project"), home);
      assert.equal(paths.target("~/notes", "/project"), `${home}/notes`);
      assert.equal(paths.target("$HOME/notes", "/project"), `${home}/notes`);
      assert.equal(paths.target("~test-user/notes", "/project"), `${home}/notes`);
      assert.equal(paths.target("~other/notes", paths.cwd), "~other/notes");
      assert.equal(paths.resolve("/project", "~/notes"), "/project/~/notes");
      assert.equal(paths.resolve("/project", "$HOME/notes"), "/project/$HOME/notes");
    });

    test("directory containment respects segment boundaries and normalized identity", () => {
      assert.ok(paths.equals("/project/./file", "/project/file/"));
      assert.ok(paths.isWithin("/project/file", "/project"));
      assert.ok(paths.isWithin("/project", "/project/"));
      assert.ok(paths.isWithin("/outside/file", "/"));
      assert.ok(!paths.isWithin("/project-other/file", "/project"));
      assert.ok(!paths.isWithin("/project/../outside/file", "/project"));
    });

    test("temporary roots use the injected environment", () => {
      const roots = paths.safeRoots();
      assert.equal(paths.temp, temp);
      assert.ok(roots.includes(temp));
      assert.ok(roots.includes("/tmp"));
      assert.ok(roots.includes("/dev/null"));
      assert.ok(roots.includes("/dev/fd"));
      assert.ok(!roots.includes("/dev/tty"));
      assert.ok(!roots.includes("/dev/disk0"));
    });
  });
}

describe("POSIX path contracts", () => {
  const paths = posixPaths;

  test("backslashes are filename characters and cannot create a directory boundary", () => {
    assert.equal(paths.normalize("/project/a\\b"), "/project/a\\b");
    assert.equal(paths.basename("/project/a\\b"), "a\\b");
    assert.ok(!paths.equals("/project/a\\b", "/project/a/b"));
    assert.ok(!paths.isWithin("/project\\file", "/project"));
    assert.equal(paths.toNative("/project/a\\b"), "/project/a\\b");
  });

  test("case and /c paths retain POSIX meaning", () => {
    assert.ok(!paths.equals("/Project/file", "/project/file"));
    assert.equal(paths.target("/c/project/file", paths.cwd), "/c/project/file");
    assert.equal(paths.target("/dev/null", paths.cwd), "/dev/null");
    assert.ok(!paths.isWindowsNativePath("C:/project/file"));
    assert.ok(!paths.isDevice("NUL"));
    assert.ok(paths.safeRoots().includes("/private/tmp"));
  });
});

describe("Windows path contracts on every host", () => {
  const paths = windowsPaths;

  test("native and Git Bash drive paths have the same canonical representation", () => {
    assert.equal(paths.target("C:\\project\\file", paths.cwd), "C:/project/file");
    assert.equal(paths.target("/c/project/file", paths.cwd), "C:/project/file");
    assert.equal(paths.target("/C/project/file", paths.cwd), "C:/project/file");
    assert.equal(paths.target("/d/data", paths.cwd), "D:/data");
    assert.equal(paths.target("/t", paths.cwd), "T:/");
    assert.equal(paths.resolve("C:/project", "../shared/file"), "C:/shared/file");
    assert.equal(paths.toNative("C:/project/file"), "C:\\project\\file");
  });

  test("rootless Git Bash namespaces do not inherit the host or cwd drive", () => {
    assert.equal(paths.target("/dev/null", "C:/project"), "/dev/null");
    assert.equal(paths.target("/etc/config", "D:/project"), "/etc/config");
    assert.equal(paths.target("/tmp/file", "C:/project"), "/tmp/file");
    assert.equal(paths.resolve("/project", "../file"), "/file");
    assert.ok(!paths.equals("/etc/config", "C:/etc/config"));
  });

  test("drive comparison ignores case but retains drive and segment boundaries", () => {
    assert.equal(paths.normalize("c:\\Project\\File"), "c:/Project/File");
    assert.ok(paths.equals("C:\\Project\\FILE", "c:/project/file"));
    assert.ok(paths.isWithin("c:/PROJECT/src/file", "C:\\project"));
    assert.ok(!paths.isWithin("C:/project-other/file", "C:/project"));
    assert.ok(!paths.isWithin("D:/project/file", "C:/project"));
    assert.equal(paths.root("C:/project/file"), "C:/");
  });

  test("UNC shares retain their namespace and compare without case sensitivity", () => {
    assert.equal(paths.normalize("\\\\server\\share\\folder\\..\\file"), "//server/share/file");
    assert.equal(paths.resolve("//server/share/project", "../file"), "//server/share/file");
    assert.ok(paths.isWithin("//SERVER/SHARE/project/file", "//server/share/project"));
    assert.ok(!paths.isWithin("//server/other/file", "//server/share"));
    assert.ok(!paths.isWithin("//server/share/file", "/"));
    assert.ok(!paths.isWithin("C:/file", "/"));
    assert.equal(paths.root("//server/share/file"), "//server/share/");
  });

  test("drive-relative paths require a known cwd for that drive", () => {
    assert.equal(paths.resolve("C:/project", "C:file"), "C:/project/file");
    assert.throws(() => paths.resolve("C:/project", "D:file"), /drive-relative path/);
    const configured = createPathAPI({
      platform: "win32",
      cwd: "C:/project",
      home: "C:/Users/test",
      username: "test",
      temp: "C:/Temp",
      driveCwds: { "D:": "D:/work" },
    });
    assert.equal(configured.resolve("C:/project", "D:file"), "D:/work/file");
    assert.equal(configured.resolve("D:/other", "D:file"), "D:/other/file");
    assert.equal(configured.target("D:file", "C:/project"), "D:/work/file");
  });

  test("Windows devices are recognized independently of the host OS", () => {
    for (const input of ["NUL", "nul.txt", "C:/project/NUL", "C:\\project\\COM1", "PRN"]) {
      assert.ok(paths.isDevice(input), input);
    }
    for (const input of ["normal.txt", "COM10", "NULL", "LPT0"]) {
      assert.ok(!paths.isDevice(input), input);
    }
  });
});

test("explicit environments reject relative host-dependent defaults", () => {
  assert.throws(
    () =>
      createPathAPI({
        platform: "win32",
        cwd: "relative",
        home: "C:/home",
        username: "test",
        temp: "C:/Temp",
      }),
    /absolute cwd, home, and temp/,
  );
});

describe("Windows native path syntax in the shared API", () => {
  const path = windowsPaths;
  test("backslash drive form is native Windows", () => {
    assert.equal(path.isWindowsNativePath("C:\\Users\\me"), true);
    assert.equal(path.isWindowsNativePath("d:\\data\\x"), true);
  });
  test("forward-slash drive form is also native Windows", () => {
    assert.equal(path.isWindowsNativePath("C:/Users/me"), true);
  });
  test("posix / MSYS / home forms are NOT native Windows", () => {
    assert.equal(path.isWindowsNativePath("/etc/passwd"), false);
    assert.equal(path.isWindowsNativePath("/c/Users/me"), false); // MSYS form
    assert.equal(path.isWindowsNativePath("~/x"), false);
  });
  test("relative paths are NOT native Windows", () => {
    assert.equal(path.isWindowsNativePath("src/foo.ts"), false);
    assert.equal(path.isWindowsNativePath("../x"), false);
  });
});
