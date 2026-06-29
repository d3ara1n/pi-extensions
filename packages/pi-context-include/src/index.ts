/**
 * Context Include Extension (@-syntax for AGENTS.md)
 *
 * Enables `@path/to/file.md` references in AGENTS.md files.
 * References must appear at the start of a line (after trimming).
 * Lines inside fenced code blocks (```) are ignored.
 *
 * On each agent turn, scans the loaded AGENTS.md files (provided via
 * systemPromptOptions.contextFiles) for `@path` patterns, reads the referenced
 * files, and injects their content into the system prompt.
 *
 * Supports:
 * - Relative paths (resolved relative to the AGENTS.md file that contains the reference)
 * - Absolute paths
 * - Home directory: `@~/.agents/file.md`
 * - Multiple `@` references per file
 * - Recursive includes (an included file can itself contain `@` references)
 * - Cycle detection + symlink-aware dedup (via realpath)
 * - Configurable depth and size limits via settings.contextInclude
 *
 * Syntax: A line starting with `@` followed by a path to a supported file type.
 * ```
 * @path/to/file.md
 * ```
 */

import { readFile, realpath } from "node:fs/promises";
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
  /** The @-reference as written (or, for depth-overflow, a display path). */
  ref: string;
  resolvedPath: string;
  reason: string;
}

// ── module-level state ───────────────────────────────────────

let _maxDepth = DEFAULT_MAX_DEPTH;
let _maxBytes = DEFAULT_MAX_BYTES;
let _lastScan: ScanDiagnostic | null = null;

async function loadConfig(cwd?: string): Promise<void> {
  const settings = await readSettings(cwd);
  const config = settings?.contextInclude as ContextIncludeConfig | undefined;
  _maxDepth = config?.maxDepth ?? DEFAULT_MAX_DEPTH;
  _maxBytes = config?.maxBytes ?? DEFAULT_MAX_BYTES;
}

/** Read merged settings (project overrides global). */
async function readSettings(cwd?: string): Promise<Record<string, unknown>> {
  const globalSettings = await readSettingsFile(
    path.join(os.homedir(), ".pi", "agent", "settings.json"),
  );
  let projectSettings: Record<string, unknown> = {};
  if (cwd) {
    projectSettings = await readSettingsFile(path.join(cwd, ".pi", "settings.json"));
  }
  return { ...globalSettings, ...projectSettings };
}

/**
 * Read and parse a settings file. Files must be valid JSON; any parse or read
 * error yields an empty object (the caller falls back to defaults).
 */
async function readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Extract @path references from a file's content.
 * Only lines starting with @ (after trim) are matched.
 * Lines inside fenced code blocks (```) are ignored.
 *
 * @internal — exported for testing.
 */
export function extractReferences(content: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");

  // @ at start of line, path ending with supported extension, nothing else on line
  const refPattern = /^@([~.]?[\w./-]+\.(?:md|txt|yaml|yml|json|toml))$/;

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

interface ResolveState {
  /** Canonical (realpath) keys for dedup + cycle detection. */
  visited: Set<string>;
  results: IncludedFile[];
  diag: ScanDiagnostic;
  maxDepth: number;
  maxBytes: number;
  /** Running byte count of included content, enforced during resolution. */
  accumulatedBytes: number;
}

/** Canonical path via realpath, falling back to a resolved path on failure. */
async function canonicalize(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Recursively resolve @path references from a file's content.
 * Dedup & cycle detection use canonical (realpath) paths so symlinks to the
 * same file are only included once.
 */
async function resolveIncludes(
  filePath: string,
  content: string,
  state: ResolveState,
  depth: number,
): Promise<void> {
  if (depth > state.maxDepth) {
    state.diag.skipped.push({
      ref: path.relative(process.cwd(), filePath) || filePath,
      resolvedPath: filePath,
      reason: `max depth (${state.maxDepth}) exceeded`,
    });
    return;
  }

  const canonical = await canonicalize(filePath);
  if (state.visited.has(canonical)) return; // cycle / already processed
  state.visited.add(canonical);

  const refs = extractReferences(content);
  const baseDir = path.dirname(canonical);

  for (const ref of refs) {
    let expandedRef = ref;
    if (expandedRef.startsWith("~")) {
      expandedRef = path.join(os.homedir(), expandedRef.slice(1));
    }

    const resolved = path.isAbsolute(expandedRef)
      ? expandedRef
      : path.resolve(baseDir, expandedRef);
    const real = await canonicalize(resolved);

    if (state.visited.has(real)) {
      state.diag.skipped.push({ ref, resolvedPath: resolved, reason: "already included" });
      continue;
    }

    let includedContent: string;
    try {
      includedContent = await readFile(real, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      state.diag.skipped.push({
        ref,
        resolvedPath: resolved,
        reason: code === "ENOENT" ? "file not found" : `read error: ${String(err)}`,
      });
      continue;
    }

    if (!includedContent) {
      state.diag.skipped.push({ ref, resolvedPath: resolved, reason: "file is empty" });
      continue;
    }

    const size = includedContent.length;
    if (state.accumulatedBytes + size > state.maxBytes) {
      state.diag.skipped.push({
        ref,
        resolvedPath: resolved,
        reason: `size limit exceeded (would reach ${state.accumulatedBytes + size} bytes)`,
      });
      continue;
    }

    state.visited.add(real);
    state.results.push({ path: resolved, content: includedContent });
    state.accumulatedBytes += size;
    state.diag.included.push({ path: resolved, bytes: size });

    // Recurse into included file for nested @references
    await resolveIncludes(real, includedContent, state, depth + 1);
  }
}

export default function contextIncludeExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await loadConfig(ctx.cwd);
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
        lines.push(
          "No scan data yet — includes are resolved each agent turn. Send a message first.",
        );
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
        lines.push(
          `⚠️  Total (${formatBytes(s.totalBytes)}) is at or above the ${formatBytes(s.maxBytes)} limit — further files were skipped.`,
        );
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

    const state: ResolveState = {
      visited: new Set(),
      results: [],
      diag,
      maxDepth: _maxDepth,
      maxBytes: _maxBytes,
      accumulatedBytes: 0,
    };

    for (const ctxFile of contextFiles) {
      if (!ctxFile.path) {
        diag.contextFiles.push({ path: "<empty>", exists: false, error: "empty path" });
        continue;
      }
      const filePath = path.resolve(ctxFile.path);

      // Context file content is already loaded by pi (systemPromptOptions);
      // we only verify reachability here.
      try {
        await realpath(filePath);
      } catch {
        diag.contextFiles.push({ path: filePath, exists: false });
        continue;
      }
      diag.contextFiles.push({ path: filePath, exists: true });

      await resolveIncludes(filePath, ctxFile.content, state, 0);
    }

    if (state.results.length === 0) {
      _lastScan = diag;
      return;
    }

    // Size limits were already enforced during resolution; here we just render.
    const sections = state.results.map((inc) => {
      const relativePath = path.relative(process.cwd(), inc.path) || inc.path;
      return `--- Begin included: ${relativePath} ---\n${inc.content}\n--- End included: ${relativePath} ---`;
    });

    diag.totalBytes = state.accumulatedBytes;
    _lastScan = diag;

    const injected = `\n\n## Included Files (via @-syntax)\n\n${sections.join("\n\n")}\n`;

    return {
      systemPrompt: (systemPrompt ?? "") + injected,
    };
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
