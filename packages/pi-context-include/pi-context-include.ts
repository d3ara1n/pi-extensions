/**
 * Context Include Extension (@-syntax for AGENTS.md)
 *
 * Enables `@path/to/file.md` references in AGENTS.md files.
 * On session start, scans all loaded AGENTS.md files for `@path` patterns,
 * reads the referenced files, and injects their content into the system prompt.
 *
 * Supports:
 * - Relative paths (resolved relative to the AGENTS.md file that contains the reference)
 * - Absolute paths
 * - Multiple `@` references per file
 * - Recursive includes (an included file can itself contain `@` references)
 * - Cycle detection to prevent infinite recursion
 *
 * Syntax: A line containing only `@path/to/file.md` or with leading text
 * that ends with whitespace before `@path`. The `@` must be followed by
 * a path (relative or absolute) to a file.
 *
 * Example AGENTS.md:
 * ```
 * # My Project Rules
 * @CODEGRAPH.md
 * @docs/api-conventions.md
 * ```
 *
 * Place in ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project-local).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_INCLUDE_DEPTH = 10;
const MAX_INCLUDED_BYTES = 500_000; // 500KB total limit for all includes

interface IncludedFile {
	path: string;
	source: string; // which AGENTS.md referenced it
	content: string;
}

/**
 * Extract @path references from a file's content.
 * Matches lines containing only `@path/to/file.md` (the entire trimmed line
 * starts with @) or inline `@path` references.
 *
 * Supported path patterns:
 * - @file.md          (bare filename)
 * - @./relative.md     (explicit relative)
 * - @../parent.md      (parent relative)
 * - @/absolute/path.md (absolute)
 * - @path/to/file.md   (multi-segment relative)
 */
function extractReferences(content: string): string[] {
	const refs: string[] = [];
	const seen = new Set<string>();
	const lines = content.split("\n");

	// Pattern: @ followed by a path that ends with a known extension
	// Path chars: alphanumeric, dots, dashes, underscores, slashes, backslashes
	// The path must end with a file extension
	const refPattern = /@([~.]?[\w./\\-]+\.(?:md|txt|yaml|yml|json|toml))(?:\s|$)/g;

	for (const line of lines) {
		const trimmed = line.trim();
		let match: RegExpExecArray | null;
		refPattern.lastIndex = 0;

		while ((match = refPattern.exec(trimmed)) !== null) {
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
	results: IncludedFile[],
): void {
	if (depth > MAX_INCLUDE_DEPTH) return;

	const canonical = path.resolve(filePath);
	if (visited.has(canonical)) return; // cycle detection
	visited.add(canonical);

	const refs = extractReferences(content);
	const baseDir = path.dirname(canonical);

	for (const ref of refs) {
		// Expand ~ to home directory
		let expandedRef = ref;
		if (expandedRef.startsWith("~")) {
			expandedRef = path.join(os.homedir(), expandedRef.slice(1));
		}

		const resolved = path.isAbsolute(expandedRef) ? expandedRef : path.resolve(baseDir, expandedRef);
		const resolvedCanonical = path.resolve(resolved);

		if (visited.has(resolvedCanonical)) continue; // already included or cycle
		if (!fs.existsSync(resolvedCanonical)) {
			console.warn(`[pi-context-include] Referenced file not found: ${ref} (resolved to ${resolvedCanonical})`);
			continue;
		}

		try {
			const includedContent = fs.readFileSync(resolvedCanonical, "utf-8");
			results.push({
				path: resolvedCanonical,
				source: canonical,
				content: includedContent,
			});

			// Recurse into included file for nested @references
			resolveIncludes(resolvedCanonical, includedContent, visited, depth + 1, results);
		} catch (err) {
			console.warn(`[pi-context-include] Failed to read ${resolvedCanonical}:`, err);
		}
	}
}

export default function contextIncludeExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const { systemPrompt, systemPromptOptions } = event;
		const contextFiles = systemPromptOptions.contextFiles;

		if (!contextFiles || contextFiles.length === 0) {
			return;
		}

		const allIncluded: IncludedFile[] = [];
		const visited = new Set<string>();

		for (const ctxFile of contextFiles) {
			// contextFiles are paths to AGENTS.md files
			const filePath = typeof ctxFile === "string" ? ctxFile : ctxFile.path;
			if (!filePath || !fs.existsSync(filePath)) continue;

			try {
				const content = fs.readFileSync(filePath, "utf-8");
				resolveIncludes(filePath, content, visited, 0, allIncluded);
			} catch (err) {
				console.warn(`[pi-context-include] Failed to read context file ${filePath}:`, err);
			}
		}

		if (allIncluded.length === 0) {
			return;
		}

		// Build the injected content with size limit
		let totalBytes = 0;
		const sections: string[] = [];

		for (const inc of allIncluded) {
			if (totalBytes + inc.content.length > MAX_INCLUDED_BYTES) {
				console.warn(
					`[pi-context-include] Skipping ${inc.path}: total included size would exceed ${MAX_INCLUDED_BYTES} bytes`,
				);
				continue;
			}

			const relativePath = path.relative(process.cwd(), inc.path) || inc.path;
			sections.push(`--- Begin included: ${relativePath} ---\n${inc.content}\n--- End included: ${relativePath} ---`);
			totalBytes += inc.content.length;
		}

		if (sections.length === 0) return;

		const injected = `\n\n## Included Files (via @-syntax)\n\n${sections.join("\n\n")}\n`;

		return {
			systemPrompt: systemPrompt + injected,
		};
	});
}
