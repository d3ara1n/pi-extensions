/**
 * Context Include Extension (@-syntax for AGENTS.md)
 *
 * Enables `@path/to/file.md` references in AGENTS.md files.
 * References must appear at the start of a line (after trimming).
 * Lines inside fenced code blocks (```) are ignored.
 *
 * On session start, scans all loaded AGENTS.md files for `@path` patterns,
 * reads the referenced files, and injects their content into the system prompt.
 *
 * Supports:
 * - Relative paths (resolved relative to the AGENTS.md file that contains the reference)
 * - Absolute paths
 * - Home directory: `@~/.agents/file.md`
 * - Multiple `@` references per file
 * - Recursive includes (an included file can itself contain `@` references)
 * - Cycle detection to prevent infinite recursion
 * - Configurable depth and size limits via settings.contextInclude
 *
 * Syntax: A line starting with `@` followed by a path to a supported file type.
 * ```
 * @path/to/file.md
 * ```
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_BYTES = 500_000; // 500KB

interface IncludedFile {
	path: string;
	content: string;
}

interface ContextIncludeConfig {
	maxDepth?: number;
	maxBytes?: number;
}

// ── diagnostics ──────────────────────────────────────────────

interface ScanDiagnostic {
	contextFiles: ContextFileDiag[];
	included: IncludedDiag[];
	skipped: SkippedDiag[];
	totalBytes: number;
	maxBytes: number;
	maxDepth: number;
}

interface ContextFileDiag {
	path: string;
	exists: boolean;
	error?: string;
}

interface IncludedDiag {
	path: string;
	bytes: number;
}

interface SkippedDiag {
	ref: string; // the @-reference as written
	resolvedPath: string;
	reason: string;
}

// ── module-level state ───────────────────────────────────────

let _maxDepth = DEFAULT_MAX_DEPTH;
let _maxBytes = DEFAULT_MAX_BYTES;
let _lastScan: ScanDiagnostic | null = null;

function loadConfig(cwd?: string): void {
	const settings = readSettings(cwd);
	const config = settings?.contextInclude as ContextIncludeConfig | undefined;
	_maxDepth = config?.maxDepth ?? DEFAULT_MAX_DEPTH;
	_maxBytes = config?.maxBytes ?? DEFAULT_MAX_BYTES;
}

/** Read merged settings (project overrides global). */
function readSettings(cwd?: string): Record<string, unknown> {
	const globalSettings = readSettingsFile(path.join(os.homedir(), ".pi", "agent", "settings.json"));
	let projectSettings: Record<string, unknown> = {};
	if (cwd) {
		projectSettings = readSettingsFile(path.join(cwd, ".pi", "settings.json"));
	}
	return { ...globalSettings, ...projectSettings };
}

function readSettingsFile(filePath: string): Record<string, unknown> {
	try {
		if (!fs.existsSync(filePath)) return {};
		const content = fs.readFileSync(filePath, "utf-8");
		const stripped = content
			.replace(/\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "");
		return JSON.parse(stripped);
	} catch {
		return {};
	}
}

/**
 * Extract @path references from a file's content.
 * Only lines starting with @ (after trim) are matched.
 * Lines inside fenced code blocks (```) are ignored.
 *
 * Exported for testing.
 */
export function extractReferences(content: string): string[] {
	const refs: string[] = [];
	const seen = new Set<string>();
	const lines = content.split("\n");

	// @ at start of line, path ending with supported extension, nothing else on line
	const refPattern = /^@([~.]?[\w./\\-]+\.(?:md|txt|yaml|yml|json|toml))$/;

	let inFencedBlock = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.startsWith("```")) {
			inFencedBlock = !inFencedBlock;
			continue;
		}

		if (inFencedBlock) continue;

		const match = refPattern.exec(trimmed);
		if (match) {
			const ref = match[1];
			if (!seen.has(ref)) {
				seen.add(ref);
				refs.push(ref);
			}
		}
	}

	return refs;
}

/**
 * Recursively resolve @path references from a file.
 */
function resolveIncludes(
	filePath: string,
	content: string,
	visited: Set<string>,
	depth: number,
	maxDepth: number,
	results: IncludedFile[],
	diag: ScanDiagnostic,
): void {
	if (depth > maxDepth) return;

	const canonical = path.resolve(filePath);
	if (visited.has(canonical)) return; // cycle detection
	visited.add(canonical);

	const refs = extractReferences(content);
	const baseDir = path.dirname(canonical);

	for (const ref of refs) {
		let expandedRef = ref;
		if (expandedRef.startsWith("~")) {
			expandedRef = path.join(os.homedir(), expandedRef.slice(1));
		}

		const resolved = path.isAbsolute(expandedRef) ? expandedRef : path.resolve(baseDir, expandedRef);

		if (visited.has(resolved)) continue; // already included or cycle
		if (!fs.existsSync(resolved)) {
			diag.skipped.push({ ref, resolvedPath: resolved, reason: "file not found" });
			console.warn(`[pi-context-include] Referenced file not found: ${ref} (resolved to ${resolved})`);
			continue;
		}

		try {
			const includedContent = fs.readFileSync(resolved, "utf-8");
			if (!includedContent) {
				diag.skipped.push({ ref, resolvedPath: resolved, reason: "file is empty" });
				continue;
			}

			results.push({ path: resolved, content: includedContent });

			// Recurse into included file for nested @references
			resolveIncludes(resolved, includedContent, visited, depth + 1, maxDepth, results, diag);
		} catch (err) {
			diag.skipped.push({ ref, resolvedPath: resolved, reason: `read error: ${String(err)}` });
			console.warn(`[pi-context-include] Failed to read ${resolved}:`, err);
		}
	}
}

export default function contextIncludeExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		loadConfig(ctx.cwd);
		_lastScan = null; // reset on new session
	});

	pi.registerCommand("context-include:status", {
		description: "Show include graph: context files, resolved includes, skipped files",
		handler: async (_args, ctx) => {
			const lines: string[] = ["**pi-context-include**", ""];
			lines.push(`maxDepth: ${_maxDepth}`);
			lines.push(`maxBytes: ${_maxBytes.toLocaleString()} (${(_maxBytes / 1024).toFixed(0)} KB)`);

			if (!_lastScan) {
				lines.push("");
				lines.push("No scan data yet — includes are resolved each agent turn. Send a message first.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const s = _lastScan;

			// Context files
			lines.push("");
			lines.push(`**Context files** (${s.contextFiles.length})`);
			for (const cf of s.contextFiles) {
				const status = cf.error ? `ERROR: ${cf.error}` : cf.exists ? "ok" : "not found";
				lines.push(`  ${status}  ${cf.path}`);
			}

			// Included files
			lines.push("");
			lines.push(`**Included** (${s.included.length} files, ${formatBytes(s.totalBytes)})`);
			for (const inc of s.included) {
				lines.push(`  ${formatBytes(inc.bytes)}  ${inc.path}`);
			}

			// Skipped files
			if (s.skipped.length > 0) {
				lines.push("");
				lines.push(`**Skipped** (${s.skipped.length})`);
				for (const sk of s.skipped) {
					lines.push(`  ${sk.reason}  @${sk.ref}  → ${sk.resolvedPath}`);
				}
			}

			// Warnings
			if (s.included.length > 0 && s.totalBytes >= s.maxBytes) {
				lines.push("");
				lines.push(`⚠️  Total (${formatBytes(s.totalBytes)}) is at or above the ${formatBytes(s.maxBytes)} limit — further files were skipped.`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("before_agent_start", async (event) => {
		const { systemPrompt, systemPromptOptions } = event;
		const contextFiles = systemPromptOptions.contextFiles;

		if (!contextFiles || contextFiles.length === 0) {
			_lastScan = null;
			return;
		}

		const diag: ScanDiagnostic = {
			contextFiles: [],
			included: [],
			skipped: [],
			totalBytes: 0,
			maxBytes: _maxBytes,
			maxDepth: _maxDepth,
		};

		const allIncluded: IncludedFile[] = [];
		const visited = new Set<string>();

		for (const ctxFile of contextFiles) {
			const rawPath = typeof ctxFile === "string" ? ctxFile : ctxFile.path;
			if (!rawPath) {
				diag.contextFiles.push({ path: "<empty>", exists: false, error: "empty path" });
				console.warn("[pi-context-include] Skipping context file entry with empty path");
				continue;
			}
			const filePath = path.resolve(rawPath);
			const exists = fs.existsSync(filePath);
			if (!exists) {
				diag.contextFiles.push({ path: filePath, exists: false });
				console.warn(`[pi-context-include] Context file not found: ${filePath}`);
				continue;
			}
			diag.contextFiles.push({ path: filePath, exists: true });

			try {
				const content = fs.readFileSync(filePath, "utf-8");
				resolveIncludes(filePath, content, visited, 0, _maxDepth, allIncluded, diag);
			} catch (err) {
				diag.contextFiles.push({ path: filePath, exists: true, error: `read error: ${String(err)}` });
				console.warn(`[pi-context-include] Failed to read context file ${filePath}:`, err);
			}
		}

		if (allIncluded.length === 0) {
			_lastScan = diag;
			return;
		}

		// Build the injected content with size limit
		let totalBytes = 0;
		const sections: string[] = [];

		for (const inc of allIncluded) {
			if (totalBytes + inc.content.length > _maxBytes) {
				diag.skipped.push({
					ref: path.relative(process.cwd(), inc.path) || inc.path,
					resolvedPath: inc.path,
					reason: `size limit exceeded (would reach ${totalBytes + inc.content.length} bytes)`,
				});
				console.warn(
					`[pi-context-include] Skipping ${inc.path}: total included size would exceed ${_maxBytes} bytes`,
				);
				continue;
			}

			const relativePath = path.relative(process.cwd(), inc.path) || inc.path;
			sections.push(`--- Begin included: ${relativePath} ---\n${inc.content}\n--- End included: ${relativePath} ---`);
			totalBytes += inc.content.length;

			diag.included.push({ path: inc.path, bytes: inc.content.length });
		}

		diag.totalBytes = totalBytes;
		_lastScan = diag;

		if (sections.length === 0) return;

		const injected = `\n\n## Included Files (via @-syntax)\n\n${sections.join("\n\n")}\n`;

		return {
			systemPrompt: systemPrompt + injected,
		};
	});
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}
