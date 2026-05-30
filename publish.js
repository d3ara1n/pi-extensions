#!/usr/bin/env node

/**
 * Publish script for pi-extensions monorepo.
 *
 * Usage:
 *   node publish.js <package-name> [patch|minor|major]
 *   node publish.js context-include         # auto patch bump
 *   node publish.js context-include minor   # bump minor
 *
 * Flow:
 *   1. Check published version on npm
 *   2. Compare with local version
 *   3. Auto-bump if needed
 *   4. Confirm → git commit + tag + push → npm publish
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ── Helpers ─────────────────────────────────────────────

function run(cmd, options = {}) {
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim();
	} catch (e) {
		if (options.allowFail) return null;
		console.error(`✗ Command failed: ${cmd}`);
		console.error(e.stderr?.trim() || e.message);
		process.exit(1);
	}
}

function info(msg) { console.log(`✓ ${msg}`); }
function warn(msg) { console.log(`⚠ ${msg}`); }
function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

function bumpVersion(version, type) {
	const [major, minor, patch] = version.split(".").map(Number);
	if (type === "major") return `${major + 1}.0.0`;
	if (type === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

// ── Args ────────────────────────────────────────────────

const pkgName = process.argv[2];
const bumpType = process.argv[3] || "patch";

if (!pkgName) {
	console.log("Usage: node publish.js <package-name> [patch|minor|major]");
	console.log("\nAvailable packages:");
	const dirs = fs.readdirSync(path.join(__dirname, "packages"), { withFileTypes: true });
	for (const d of dirs.filter((d) => d.isDirectory())) {
		const pkgJson = path.join(__dirname, "packages", d.name, "package.json");
		if (fs.existsSync(pkgJson)) {
			const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
			console.log(`  ${d.name.padEnd(24)} ${pkg.description || ""}`);
		}
	}
	process.exit(0);
}

// ── Resolve package ─────────────────────────────────────

const pkgDir = path.join(__dirname, "packages", pkgName);
if (!fs.existsSync(pkgDir)) die(`Package not found: ${pkgDir}`);

const pkgJsonPath = path.join(pkgDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
const fullName = pkg.name;

console.log("");
console.log("────────────────────────────────────────");
console.log(`  ${fullName}`);
console.log("────────────────────────────────────────");
console.log("");

// ── 1. Check remote version ─────────────────────────────

const remoteVersion = run(`npm view ${fullName} version 2>/dev/null`, { allowFail: true }) || "0.0.0";
const localVersion = pkg.version;

console.log(`  Remote: ${remoteVersion}`);
console.log(`  Local:  ${localVersion}`);
console.log("");

// ── 2. Determine target version ─────────────────────────

let targetVersion;

if (remoteVersion === "0.0.0") {
	targetVersion = localVersion;
	info(`First publish, using local version ${targetVersion}`);
} else {
	const [rmajor, rminor, rpatch] = remoteVersion.split(".").map(Number);
	const [lmajor, lminor, lpatch] = localVersion.split(".").map(Number);
	const localHigher = lmajor > rmajor || lminor > rminor || lpatch > rpatch;

	if (localHigher) {
		targetVersion = localVersion;
		info(`Local version is higher, publishing as-is: ${targetVersion}`);
	} else {
		targetVersion = bumpVersion(remoteVersion, bumpType);
		info(`Auto-bumping (${bumpType}): ${remoteVersion} → ${targetVersion}`);
	}
}

// ── 3. Confirm ──────────────────────────────────────────

const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question(`\n  Publish ${fullName}@${targetVersion}? [Y/n] `, (answer) => {
	rl.close();

	if (answer.toLowerCase() === "n") {
		warn("Cancelled");
		process.exit(0);
	}

	// ── 4. Update package.json version ────────────────────
	pkg.version = targetVersion;
	fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");
	info(`Version set to ${targetVersion}`);

	// ── 5. Git commit + tag + push ────────────────────────
	const tag = `${fullName}@${targetVersion}`;

	run(`git add ${path.relative(process.cwd(), pkgJsonPath)}`);
	run(`git commit -m "release: ${tag}"`, { allowFail: true });
	run(`git tag ${tag}`);
	info(`Git tag: ${tag}`);

	run("git push");
	run("git push --tags");
	info("Git pushed");

	// ── 6. npm publish ────────────────────────────────────
	run(`npm publish -w ${pkgDir} --access public`);
	info(`Published to npm: ${tag}`);

	console.log("");
	info("Done! 🚀");
	console.log("");
	console.log(`  Install: pi install npm:${fullName}`);
	console.log("");
});
