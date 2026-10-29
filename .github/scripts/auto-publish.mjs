/**
 * Auto-publish script for pi-extensions monorepo.
 *
 * Triggered by GitHub Actions on every push to main.
 *
 * For each package in packages/:
 *   1. Find the latest published version (npm tag)
 *   2. Parse conventional commits since that tag
 *   3. Determine bump level (feat → minor, fix → patch, ! → major)
 *   4. Publish, save the source tag, then update version fields on main
 *
 * Commits without a matching scope or with chore/docs/refactor/style/test
 * are ignored — no publish triggered.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { saveReleaseTag, writeReleaseVersions } from "./release-records.mjs";

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
 *   feat(pi-context-include): add nested includes
 *   fix(pi-context-include)!: handle missing files
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

// ── Spinlock ──────────────────────────────────────────

/**
 * Block until no other publish workflow is in progress.
 * Uses the GitHub Actions API to avoid concurrent runs clashing.
 */
async function waitForOtherPublishRuns() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;

  if (!token || !repo || !runId) {
    log("⚠ Skipping spinlock — missing GITHUB_* env vars");
    return;
  }

  const apiUrl = `https://api.github.com/repos/${repo}/actions/runs?status=in_progress&per_page=100`;
  const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes
  const POLL_INTERVAL_MS = 5000;
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    const response = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      log(`⚠ Spinlock API error ${response.status}, proceeding`);
      return;
    }

    const data = await response.json();
    const thisWorkflow = process.env.GITHUB_WORKFLOW || "Publish";
    const others = data.workflow_runs.filter(
      r =>
        r.id !== Number(runId) &&
        r.status === "in_progress" &&
        r.name === thisWorkflow
    );

    if (others.length === 0) {
      log("🔓 No other publish runs, proceeding");
      return;
    }

    log(`🔒 ${others.length} other publish run(s) active, waiting ${POLL_INTERVAL_MS / 1000}s...`);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  log("⚠ Spinlock timeout, proceeding");
}

// ── Discover packages ───────────────────────────────────

const rootDir = resolve(import.meta.dirname, "../..");
const packagesDir = join(rootDir, "packages");
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

await waitForOtherPublishRuns();

console.log(`Scanning ${packageDirs.length} package(s)...\n`);

const published = [];
let failed = 0;

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

  if (!tagExists) {
    if (remoteVersion === "0.0.0") {
      // Never published — create baseline tag at HEAD so future runs work.
      run(`git -c user.name="github-actions[bot]" -c user.email="github-actions[bot]@users.noreply.github.com" tag ${lastTag}`);
      run(`git push origin refs/tags/${lastTag}`);
      log(`Created baseline tag: ${lastTag}`);
      log("No previous publish, skipping");
      continue;
    }
    // Published but missing tag — this is a bug (tag was never pushed / created).
    // Bail out rather than silently baseline and skip commits.
    console.error(`  ❌ Tag missing: ${lastTag} — npm has ${remoteVersion} but no matching git tag.`);
    console.error(`     Create the tag manually at the release commit and re-run.`);
    failed++;
    continue;
  }

  const commitsToCheck = run(`git log --format="%H" ${lastTag}..HEAD`).split("\n").filter(Boolean);

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

    // A commit targets a package if any comma-separated scope matches the package dir.
    // Unscoped commits match nothing — they never trigger a publish.
    if (!parsed.scope?.split(",").map((s) => s.trim()).includes(dir)) continue;

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

  // ── 5.5 Registry-lag guard ──────────────────────────────
  // npm's read API is eventually consistent: a sibling publish run that just
  // finished may already have published this exact version while the
  // `npm view` above still served the older one (observed as E409 "cannot
  // publish over previously staged version"). Skip past taken versions.
  while (run(`npm view ${fullName}@${newVersion} version`, { allowFail: true })) {
    const [mj, mn, pt] = newVersion.split(".").map(Number);
    log(`⚠ ${newVersion} already on npm (registry lag from a sibling run), trying ${mj}.${mn}.${pt + 1}`);
    newVersion = `${mj}.${mn}.${pt + 1}`;
  }

  log(`Bump: ${baseVersion} → ${newVersion} (${bumpLevel})`);

  // ── 6. Publish, then commit + tag only on success ───────
  const originalVersion = pkg.version;

  // Write new version to package.json for publish
  pkg.version = newVersion;
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

  try {
    // E409 safety net: if the version raced onto npm between the guard above
    // and this publish, bump patch and retry instead of failing the run — a
    // skipped version number costs nothing, a failed release run doesn't
    // self-heal.
    for (let attempt = 1; ; attempt++) {
      try {
        run(`npm publish -w ${pkgDir} --access public --provenance`);
        break;
      } catch (e) {
        const msg = e.stderr?.trim() || e.message || "";
        if ((!msg.includes("E409") && !msg.includes("previously staged")) || attempt >= 3) throw e;
        const [mj, mn, pt] = newVersion.split(".").map(Number);
        log(`⚠ E409 on ${newVersion}, retrying as ${mj}.${mn}.${pt + 1}`);
        newVersion = `${mj}.${mn}.${pt + 1}`;
        pkg.version = newVersion;
        writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");
      }
    }
  } catch (e) {
    // Publish failed — revert package.json, continue to next package
    pkg.version = originalVersion;
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");
    console.error(`  ❌ Failed to publish ${fullName}@${newVersion}: ${e.stderr?.trim() || e.message}`);
    failed++;
    continue;
  }
  log(`✅ Published ${fullName}@${newVersion}`);
  const release = { dir, name: fullName, version: newVersion };
  published.push(release);
  // Preserve successful npm releases even if updating main later fails.
  // Bookkeeping failures must not be reported as failed npm publications.
  log(`Saved tag: ${saveReleaseTag(rootDir, release)}`);
}

console.log(`\n${"─".repeat(40)}`);
console.log(`Published ${published.length} package(s), ${failed} failed`);

if (failed > 0) {
  process.exitCode = 1;
}

writeReleaseVersions(rootDir, published);
