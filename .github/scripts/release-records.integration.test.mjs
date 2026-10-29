import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveReleaseTag, writeReleaseVersions } from "./release-records.mjs";

const gitAvailable = (() => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

function git(cwd, ...args) {
  return execFileSync("git", [
    "-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", ...args,
  ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-release-records-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const isolatedConfig = join(root, "gitconfig");
  writeFileSync(isolatedConfig, "");
  for (const [key, value] of Object.entries({
    GIT_CONFIG_GLOBAL: isolatedConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const runner = join(root, "runner");
  const manifest = "packages/example/package.json";
  mkdirSync(source);
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(source, "init", "--initial-branch=main");
  mkdirSync(join(source, "packages/example"), { recursive: true });
  writeFileSync(join(source, manifest), JSON.stringify({ name: "@test/example", version: "0.5.0", description: "original" }, null, 2) + "\n");
  writeFileSync(join(source, "packages/example/code.js"), "export const value = 'published';\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "initial source");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "origin", "main");
  git(root, "clone", remote, runner);
  const release = { dir: "example", name: "@test/example", version: "0.5.2" };
  const pkg = JSON.parse(readFileSync(join(runner, manifest), "utf8"));
  pkg.version = release.version;
  writeFileSync(join(runner, manifest), JSON.stringify(pkg, null, 2) + "\n");
  return { source, remote, runner, manifest, release };
}

test("a stale release snapshot updates only the version on newer main and keeps the published source tag", { skip: !gitAvailable }, (t) => {
  const { source, remote, runner, manifest, release } = fixture(t);
  const current = { name: release.name, version: "0.5.1", description: "new metadata", extra: true };
  writeFileSync(join(source, manifest), JSON.stringify(current, null, 2) + "\n");
  writeFileSync(join(source, "packages/example/code.js"), "export const value = 'newer main';\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "advance main during release");
  git(source, "push", "origin", "main");

  const tag = saveReleaseTag(runner, release);
  writeReleaseVersions(runner, [release]);

  assert.deepEqual(JSON.parse(git(remote, "show", `main:${manifest}`)), { ...current, version: "0.5.2" });
  assert.equal(git(remote, "show", "main:packages/example/code.js"), "export const value = 'newer main';");
  assert.equal(git(remote, "show", `${tag}:packages/example/code.js`), "export const value = 'published';");
  assert.equal(JSON.parse(git(remote, "show", `${tag}:${manifest}`)).version, "0.5.2");
});

test("a saved release tag survives a later failure to update main", { skip: !gitAvailable }, (t) => {
  const { source, remote, runner, manifest, release } = fixture(t);
  git(source, "rm", "-r", "packages/example");
  git(source, "commit", "-m", "remove package on newer main");
  git(source, "push", "origin", "main");

  const tag = saveReleaseTag(runner, release);
  assert.throws(() => writeReleaseVersions(runner, [release]), { code: "ENOENT" });
  assert.equal(JSON.parse(git(remote, "show", `${tag}:${manifest}`)).version, "0.5.2");
  assert.equal(git(remote, "show", `${tag}:packages/example/code.js`), "export const value = 'published';");
});
