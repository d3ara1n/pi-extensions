import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function git(cwd, ...args) {
  return execFileSync("git", [
    "-c", "user.name=github-actions[bot]",
    "-c", "user.email=github-actions[bot]@users.noreply.github.com",
    ...args,
  ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Save the exact published snapshot before attempting any main-branch bookkeeping. */
export function saveReleaseTag(rootDir, { dir, name, version }) {
  const tag = `${name}@${version}`;
  git(rootDir, "add", "--", `packages/${dir}/package.json`);
  if (git(rootDir, "diff", "--cached", "--name-only")) {
    git(rootDir, "commit", "-m", `release: ${tag}`);
  }
  git(rootDir, "tag", tag);
  git(rootDir, "push", "origin", `refs/tags/${tag}`);
  return tag;
}

/** Update only version fields on current main; release tags retain their original snapshots. */
export function writeReleaseVersions(rootDir, releases) {
  if (!releases.length) return;
  git(rootDir, "fetch", "origin", "main");
  git(rootDir, "switch", "--detach", "origin/main");
  const changed = [];
  for (const release of releases) {
    const relativePath = `packages/${release.dir}/package.json`;
    const file = join(rootDir, relativePath);
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.version === release.version) continue;
    pkg.version = release.version;
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    git(rootDir, "add", "--", relativePath);
    changed.push(`${release.name}@${release.version}`);
  }
  if (!changed.length) return;
  git(rootDir, "commit", "-m", `release: ${changed.join(", ")}`);
  git(rootDir, "push", "origin", "HEAD:refs/heads/main");
}
