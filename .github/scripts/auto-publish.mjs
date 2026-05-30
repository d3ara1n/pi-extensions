/**
 * Auto-publish script for pi-extensions monorepo.
 *
 * Triggered by GitHub Actions on every push to main.
 *
 * For each package in packages/:
 *   1. Find the latest published version (npm tag)
 *   2. Parse conventional commits since that tag
 *   3. Determine bump level (feat → minor, fix → patch, ! → major)
 *   4. Bump version, commit, tag, publish
 *
 * Commits without a matching scope or with chore/docs/refactor/style/test
 * are ignored — no publish triggered.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Helpers ─────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (opts.allowFail) return null;
    throw new Error(`Command failed: ${cmd}\n${e.stderr?.trim() || e.message}`);
  }
}

function log(msg) { console.log(`  ${msg}`); }

// ── Conventional commit parser ──────────────────────────

/**
 * Parse a conventional commit message.
 * Returns { type, scope, breaking, description } or null.
 *
 * Examples:
 *   feat(context-include): add nested includes
 *   fix(context-include)!: handle missing files
 *   chore: update deps
 */
function parseCommit(message) {
  const firstLine = message.split("\n")[0];
  const match = firstLine.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*)/);
  if (!match) return null;
  return {
    type: match[1],
    scope: match[2] || null,
    breaking: !!match[3] || message.includes("\nBREAKING CHANGE:"),
    description: match[4],
  };
}

// ── Discover packages ───────────────────────────────────

const rootDir = resolve(import.meta.dirname, "../..");
const packagesDir = join(rootDir, "packages");
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

console.log(`Scanning ${packageDirs.length} package(s)...\n`);

let published = 0;

for (const dir of packageDirs) {
  const pkgDir = join(packagesDir, dir);
  const pkgJsonPath = join(pkgDir, "package.json");

  if (!existsSync(pkgJsonPath)) {
    log(`⊘ ${dir}: no package.json, skipping`);
    continue;
  }

  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const fullName = pkg.name;
  console.log(`\n📦 ${fullName}`);

  // ── 1. Get latest published version ────────────────────
  const remoteVersion = run(`npm view ${fullName} version`, { allowFail: true }) || "0.0.0";
  log(`npm:  ${remoteVersion}`);
  log(`local: ${pkg.version}`);

  // ── 2. Get commits since last tag ─────────────────────
  const lastTag = `${fullName}@${remoteVersion}`;
  const tagExists = run(`git tag -l "${lastTag}"`, { allowFail: true });

  let commitsToCheck;
  if (!tagExists) {
    // Never published or no tag — check last 50 commits
    commitsToCheck = run(`git log --format="%H" -50`).split("\n").filter(Boolean);
  } else {
    commitsToCheck = run(`git log --format="%H" ${lastTag}..HEAD`).split("\n").filter(Boolean);
  }

  if (commitsToCheck.length === 0) {
    log("No new commits, skipping");
    continue;
  }

  // ── 3. Parse commits for this package's scope ──────────
  let hasMajor = false;
  let hasMinor = false;
  let hasPatch = false;
  let relevantCount = 0;

  for (const hash of commitsToCheck) {
    const message = run(`git log --format="%B" -1 ${hash}`);
    const parsed = parseCommit(message);
    if (!parsed) continue;

    // Check if this commit targets our package
    // Match by scope name: feat(context-include) matches "context-include" dir
    if (parsed.scope && parsed.scope !== dir) continue;

    const isRelevantType = ["feat", "fix"].includes(parsed.type);
    if (!isRelevantType) continue;

    relevantCount++;
    if (parsed.breaking) hasMajor = true;
    else if (parsed.type === "feat") hasMinor = true;
    else if (parsed.type === "fix") hasPatch = true;
  }

  if (relevantCount === 0) {
    log("No relevant conventional commits, skipping");
    continue;
  }

  log(`Found ${relevantCount} relevant commit(s) (major=${hasMajor} minor=${hasMinor} patch=${hasPatch})`);

  // ── 4. Determine bump level ────────────────────────────
  let bumpLevel;
  if (hasMajor) bumpLevel = "major";
  else if (hasMinor) bumpLevel = "minor";
  else bumpLevel = "patch";

  // ── 5. Calculate new version ───────────────────────────
  const baseVersion = remoteVersion === "0.0.0" ? pkg.version : remoteVersion;
  const [major, minor, patch] = baseVersion.split(".").map(Number);
  let newVersion;
  if (bumpLevel === "major") newVersion = `${major + 1}.0.0`;
  else if (bumpLevel === "minor") newVersion = `${major}.${minor + 1}.0`;
  else newVersion = `${major}.${minor}.${patch + 1}`;

  log(`Bump: ${baseVersion} → ${newVersion} (${bumpLevel})`);

  // ── 6. Update, commit, tag, publish ─────────────────────
  pkg.version = newVersion;
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

  // Stage and commit
  run(`git add ${pkgJsonPath}`);
  run(`git -c user.name="github-actions[bot]" -c user.email="github-actions[bot]@users.noreply.github.com" commit -m "release: ${fullName}@${newVersion}"`);

  // Tag
  const tag = `${fullName}@${newVersion}`;
  run(`git -c user.name="github-actions[bot]" -c user.email="github-actions[bot]@users.noreply.github.com" tag ${tag}`);
  log(`Tagged: ${tag}`);

  // Publish
  run(`npm publish -w ${pkgDir} --access public --provenance`);
  log(`✅ Published ${fullName}@${newVersion}`);
  published++;
}

console.log(`\n${"─".repeat(40)}`);
console.log(`Published ${published} package(s)`);

if (published > 0) {
  // Push the version commits back
  run("git push");
}
