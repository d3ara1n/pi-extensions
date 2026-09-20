/**
 * Override grep: search results carry `LINE#HASH│` anchors (same format as
 * read), grouped by file. The model can copy `LINE#HASH` straight into an edit
 * anchor — no re-read needed. Context lines (`context`) are anchored too.
 *
 * Beyond the built-in grep it covers the compound queries models otherwise
 * drop to bash pipelines for: multi-pattern AND (`matchMode: "all"` ≈
 * `grep A | grep B`), line exclusion (`excludePattern` ≈ `grep -v`),
 * whole-word matching (`wordMatch` ≈ `-w`), multiple search roots, and
 * files-only / count output (`outputMode` ≈ `rg -l` / `grep -c`).
 *
 * We run ripgrep directly (`--json`) rather than wrap the built-in grep, so we
 * control formatting and can compute each line's hash from its FULL content
 * while displaying a truncated copy. (The built-in grep truncates long lines
 * before formatting; hashing that truncated text would not match what edit
 * verifies against the full line — so the hash must be computed from the full
 * content, independently of what is displayed.)
 *
 * Filters run in two places: rg gets every pattern as `-e` (native OR) plus
 * the global flags; the AND / exclude checks then run client-side on each
 * matched line's text (streamed by rg), so `limit` counts final results, not
 * pre-filter candidates. Context windows are likewise rebuilt client-side from
 * the surviving matches — context lines of a filtered-out match never leak.
 *
 * Falls back to the built-in grep when aborted or when ripgrep cannot be
 * located (the built-in can auto-download rg). Extended params never
 * delegate — the built-in would misread them.
 *
 * @module pi-hashline-edit/pi
 */

import {
  getAgentDir,
  createGrepTool,
  truncateHead,
  truncateLine,
  formatSize,
  DEFAULT_MAX_BYTES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access, constants, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashFileLines } from "../core/hash.ts";
import { splitLines } from "../core/lines.ts";
import { getState } from "./state.ts";
import { canonicalPath } from "./read-tool.ts";
import { parseHashline } from "./render.ts";

const DEFAULT_LIMIT = 100;
/** Max chars per result line for display (mirrors pi's truncate.ts; not exported there). */
const GREP_MAX_LINE_LENGTH = 500;
const GREP_CONTEXT_MAX = 20;

/** Locate ripgrep: pi's bundled bin first, then PATH. Returns null if not found. */
async function findRg(): Promise<string | null> {
  const executable = process.platform === "win32" ? "rg.exe" : "rg";
  const agentDir = getAgentDir();
  const piRg = join(agentDir, "bin", executable);
  try {
    await access(piRg, constants.X_OK);
    return piRg;
  } catch {}
  for (const dir of process.env.PATH?.split(delimiter) ?? []) {
    if (!dir) continue;
    const p = join(dir, executable);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** Escape a literal string for use as a regex source. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a pattern for the client-side line checks (`matchMode: "all"` and
 * `excludePattern`), mirroring the flags rg was given — `literal`,
 * `ignoreCase`, and (for the AND check) `wordMatch` — so a line rg accepted is
 * judged by the same semantics here. Patterns valid in rg but invalid as a JS
 * regex (e.g. `(?P<name>…)`) throw rather than silently degrade.
 */
function compileLineMatcher(
  pattern: string,
  opts: { literal: boolean; ignoreCase: boolean; word: boolean },
): RegExp {
  let source = opts.literal ? escapeRegex(pattern) : pattern;
  if (opts.word) source = `\\b(?:${source})\\b`;
  const flags = opts.ignoreCase ? "iu" : "u";
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new Error(
      `Pattern not supported for line filtering: ${pattern} (${(err as Error).message})`,
    );
  }
}

/** Normalize a `string | string[]` param to an array (`undefined` → `[]`). */
function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function clampContext(context: number | undefined): number {
  if (!context || !Number.isFinite(context) || context < 0) return 0;
  return Math.min(Math.floor(context), GREP_CONTEXT_MAX);
}

const grepOverrideSchema = Type.Object({
  pattern: Type.Union([Type.String(), Type.Array(Type.String())], {
    description:
      "Regex pattern, or literal text with literal:true. String or array; arrays combine per matchMode.",
  }),
  matchMode: Type.Optional(
    Type.Union([Type.Literal("any"), Type.Literal("all")], {
      description:
        '"any" (default): OR. "all": AND on the same line.',
    }),
  ),
  excludePattern: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "Drop lines matching any exclusion after pattern matching; uses the same literal and ignoreCase settings.",
    }),
  ),
  outputMode: Type.Optional(
    Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
      description: '"content" (default): anchored lines. "files": paths. "count": matching lines per file and total.',
    }),
  ),
  wordMatch: Type.Optional(Type.Boolean({ description: "Match whole words only (rg -w)" })),
  path: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
    description:
      "Directory or file to search (string or array of paths; default: current directory)",
  })),
  glob: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "Filter files (including explicit file paths) by glob; pass an ordered array for multiple filters and prefix exclusions with `!`, e.g. ['*.ts', '!**/*.test.ts']",
    }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "Case-insensitive search (default: false); applies to pattern and excludePattern." }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description: "Treat pattern and excludePattern as literal text (default: false; regex). Invalid regexes return an error.",
    }),
  ),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: GREP_CONTEXT_MAX,
      description: `Number of lines on each side of a match (0-${GREP_CONTEXT_MAX}; default: 0); context lines are anchored too`,
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of matching lines to return (default: 100)" }),
  ),
});

interface RgMatch {
  filePath: string;
  lineNumber: number;
}

interface RgRunResult {
  code: number | null;
  stderr: string;
  stopped: boolean;
}

/** @internal — injectable process and fallback boundary for deterministic tests. */
export interface GrepBackend {
  findRg(): Promise<string | null>;
  listFiles(
    rgPath: string,
    directories: string[],
    globs: string[],
    signal: AbortSignal | undefined,
  ): Promise<Set<string>>;
  runRg(
    rgPath: string,
    args: string[],
    signal: AbortSignal | undefined,
    onLine: (line: string) => boolean,
  ): Promise<RgRunResult>;
  delegate(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: any,
  ): Promise<any>;
}

/** List direct children using rg's own ordered glob rules (including ignored files). */
function listRgFiles(
  rgPath: string,
  directories: string[],
  globs: string[],
  signal: AbortSignal | undefined,
): Promise<Set<string>> {
  return new Promise((resolveFiles, reject) => {
    if (signal?.aborted) return reject(new Error("Operation aborted"));
    const args = ["--files", "--null", "--hidden", "--no-ignore", "--follow", "--max-depth=1"];
    for (const glob of globs) args.push("--glob", glob);
    args.push("--", ...directories);
    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Failed to run ripgrep: ${error.message}`));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("Operation aborted"));
      if (code !== 0 && code !== 1) {
        return reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
      }
      const paths = Buffer.concat(chunks).toString("utf-8").split("\0").filter(Boolean);
      resolveFiles(new Set(paths));
    });
  });
}

/** Run ripgrep and stream its JSON lines to the caller until it asks to stop. */
function runRg(
  rgPath: string,
  args: string[],
  signal: AbortSignal | undefined,
  onLine: (line: string) => boolean,
): Promise<RgRunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    let stopped = false;
    let settled = false;

    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const stopChild = () => {
      stopped = true;
      if (!child.killed) child.kill();
    };
    const onAbort = () => stopChild();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    rl.on("line", (line: string) => {
      if (!line.trim() || stopped) return;
      if (!onLine(line)) stopChild();
    });
    child.on("error", (error) => {
      settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
    });
    child.on("close", (code) => {
      settle(() => resolve({ code, stderr, stopped }));
    });
  });
}

/**
 * Convert the anchored grep output (grouped, `LINE#HASH│`) into a human-readable
 * form for the TUI: drop the hash, keep file headers and line numbers. Within each
 * file group, the common leading whitespace shared by all matched lines is folded
 * into a single marker (›) so deep, repeated indentation doesn't eat display width;
 * each line's indentation relative to that common base is preserved. The model still
 * receives the anchored `content` text verbatim — this only affects what the user sees.
 */
function countLeading(s: string): number {
  const m = s.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

function toDisplayLines(raw: string, theme: any): string[] {
  const out: string[] = [];
  const lines = raw.split("\n");
  const lineNoWidth = lines.reduce(
    (width, line) => Math.max(width, parseHashline(line)?.lineNo.length ?? 0),
    0,
  );
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(/^(.+?) · (\d+ match(?:es)?)$/);
    if (h) {
      out.push(theme.fg("success", h[1]) + theme.fg("dim", ` · ${h[2]}`));
      // collect the anchor lines in this file group
      const group: { lineNo: string; content: string }[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const a = parseHashline(lines[j]);
        if (!a) break;
        group.push({ lineNo: a.lineNo, content: a.content });
        j++;
      }
      // common base = min leading whitespace across the group; fold it into a marker
      const base = group.length ? Math.min(...group.map((g) => countLeading(g.content))) : 0;
      const marker = base > 0 ? theme.fg("dim", "›") + " " : "";
      for (const g of group) {
        const body = g.content.slice(base);
        out.push(theme.fg("dim", `   ${g.lineNo.padStart(lineNoWidth)}: `) + marker + theme.fg("toolOutput", body));
      }
      i = j;
      continue;
    }
    if (line.startsWith("[")) out.push(theme.fg("warning", line));
    else out.push(theme.fg("toolOutput", line));
    i++;
  }
  return out;
}

/** Build the production grep override (a ToolDefinition fragment for registerTool). */
export function makeGrepOverride(cwd: string) {
  return makeGrepOverrideWithBackend(cwd, {});
}

/** @internal — build a grep override with deterministic process and fallback backends for tests. */
export function makeGrepOverrideWithBackend(cwd: string, overrides: Partial<GrepBackend>) {
  let builtin: ReturnType<typeof createGrepTool> | undefined;
  const backend: GrepBackend = {
    findRg,
    listFiles: listRgFiles,
    runRg,
    delegate(toolCallId, params, signal, onUpdate) {
      builtin ??= createGrepTool(cwd);
      return builtin.execute(toolCallId, params, signal, onUpdate);
    },
    ...overrides,
  };

  return {
    name: "grep" as const,
    label: "grep",
    description:
      "Search file contents, respecting .gitignore. Content results are grouped by file and include LINE#HASH anchors usable in edit; built-in grep fallback results have no anchors.",
    promptSnippet: "Search file contents with edit-ready line anchors",
    promptGuidelines: [
      "Prefer the grep tool for file-content searches.",
      "Use returned LINE#HASH anchors directly in edit when present; no re-read is needed.",
      'Use outputMode:"files"/"count" when only paths or counts are needed; use matchMode:"all" and excludePattern for line-level filters instead of shell pipelines.',
    ],
    parameters: grepOverrideSchema,

    renderShell: "default" as const,

    renderCall(args: any, theme: any) {
      const rawPattern = args?.pattern;
      const patternText = Array.isArray(rawPattern)
        ? rawPattern.join(" | ")
        : String(rawPattern ?? "");
      const rawPath = args?.path;
      const pathText = Array.isArray(rawPath) ? rawPath.join(" ") : String(rawPath ?? ".");
      let text =
        theme.fg("toolTitle", theme.bold("grep ")) +
        theme.fg("accent", `/${patternText}/`) +
        theme.fg("toolOutput", ` in ${pathText}`);
      if (args?.matchMode === "all") text += theme.fg("accent", " all");
      if (args?.excludePattern) {
        const ex = Array.isArray(args.excludePattern)
          ? args.excludePattern.join(",")
          : args.excludePattern;
        text += theme.fg("toolOutput", ` -v:${ex}`);
      }
      if (args?.wordMatch) text += theme.fg("toolOutput", " -w");
      if (args?.glob) text += theme.fg("toolOutput", ` (${toArray(args.glob).join(", ")})`);
      if (args?.outputMode && args.outputMode !== "content")
        text += theme.fg("success", ` → ${args.outputMode}`);
      if (args?.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { isPartial, expanded }: any, theme: any, context: any) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
      if (context?.isError) {
        const t =
          result.content?.[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Error";
        return new Text(theme.fg("error", t), 0, 0);
      }
      const out = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      const styled = toDisplayLines(out, theme);
      const maxLines = expanded ? styled.length : 15;
      const shown = styled.slice(0, maxLines);
      const more =
        !expanded && styled.length > maxLines
          ? `\n${theme.fg("muted", `… (${styled.length - maxLines} more lines)`)}`
          : "";
      return new Text(shown.join("\n") + more, 0, 0);
    },

    async execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
    ): Promise<any> {
      const state = getState();
      const ctx = clampContext(params.context);
      const delegatedParams = params.context === undefined ? params : { ...params, context: ctx };
      // aborted → built-in grep (it handles abort itself)
      if (signal?.aborted) return backend.delegate(toolCallId, delegatedParams, signal, onUpdate);

      const patterns = toArray(params.pattern);
      if (patterns.length === 0) throw new Error("pattern is required (got an empty array)");

      // Plain built-in-shaped params (single string pattern/path, no new fields)
      // can delegate safely; anything else must run the local pipeline below.
      const legacyShaped =
        typeof params.pattern === "string" &&
        params.matchMode === undefined &&
        params.excludePattern === undefined &&
        params.outputMode === undefined &&
        params.wordMatch === undefined &&
        !Array.isArray(params.glob) &&
        !Array.isArray(params.path);

      const globs = toArray(params.glob);
      const rgPath = await backend.findRg();
      // The built-in grep also lets explicit files bypass globs.
      if (!rgPath) {
        if (legacyShaped) {
          if (params.glob !== undefined && params.path !== undefined) {
            const path = canonicalPath(cwd, params.path);
            let explicitFile = false;
            try { explicitFile = (await stat(path)).isFile(); } catch {}
            if (explicitFile) throw new Error("ripgrep (rg) not found; cannot apply glob to an explicit file");
          }
          return backend.delegate(toolCallId, delegatedParams, signal, onUpdate);
        }
        throw new Error(
          "ripgrep (rg) not found; extended grep params cannot fall back to the built-in grep. Retry with a simple pattern first, or use bash",
        );
      }

      const excludes = toArray(params.excludePattern);
      const matchMode: "any" | "all" = params.matchMode ?? "any";
      const outputMode: "content" | "files" | "count" = params.outputMode ?? "content";
      const { ignoreCase, literal, wordMatch, limit } = params;
      const searchPaths = (() => {
        const raw = toArray(params.path);
        return (raw.length ? raw : ["."]).map((p) => canonicalPath(cwd, p));
      })();
      const hashLen = state.config.hashLen;

      // rg ignores globs for explicit files, so select those with its file walker first.
      const pathInfo: { path: string; isFile: boolean }[] = [];
      const parents = new Set<string>();
      for (const sp of searchPaths) {
        let info;
        try {
          info = await stat(sp);
        } catch {
          throw new Error(`Path not found: ${sp}`);
        }
        const isFile = info.isFile();
        pathInfo.push({ path: sp, isFile });
        if (globs.length && isFile) parents.add(dirname(sp));
      }
      const fileKey = (path: string) => {
        const absolute = resolve(cwd, path);
        return process.platform === "win32" ? absolute.toLowerCase() : absolute;
      };
      const listed = parents.size
        ? await backend.listFiles(rgPath, [...parents], globs, signal)
        : new Set<string>();
      const allowed = new Set([...listed].map(fileKey));
      const selectedPaths = pathInfo
        .filter(({ path, isFile }) => !globs.length || !isFile || allowed.has(fileKey(path)))
        .map(({ path }) => path);
      if (signal?.aborted) throw new Error("Operation aborted");
      if (selectedPaths.length === 0) return {
        content: [{ type: "text", text: "No matches found" }],
        details: undefined,
      };

      // Client-side line filters — only AND / exclude need them; "any" is native rg (-e OR).
      const excludeMatchers = excludes.map((p) =>
        compileLineMatcher(p, { literal: !!literal, ignoreCase: !!ignoreCase, word: false }),
      );
      const andMatchers =
        matchMode === "all" && patterns.length > 1
          ? patterns.map((p) =>
              compileLineMatcher(p, {
                literal: !!literal,
                ignoreCase: !!ignoreCase,
                word: !!wordMatch,
              }),
            )
          : [];
      const linePasses = (line: string): boolean =>
        andMatchers.every((re) => re.test(line)) && !excludeMatchers.some((re) => re.test(line));

      return new Promise((resolvePromise, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        const args = ["--json", "--line-number", "--color=never", "--hidden"];
        if (ignoreCase) args.push("--ignore-case");
        if (literal) args.push("--fixed-strings");
        if (wordMatch) args.push("--word-regexp");
        for (const glob of globs) args.push("--glob", glob);
        for (const p of patterns) args.push("-e", p);
        args.push("--", ...selectedPaths);

        const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
        let matchCount = 0;
        let matchLimitReached = false;
        let linesTruncated = false;
        const raw: RgMatch[] = [];

        backend
          .runRg(rgPath, args, signal, (line) => {
            if (matchCount >= effectiveLimit) return false;
            let event: any;
            try {
              event = JSON.parse(line);
            } catch {
              return true;
            }
            if (event.type !== "match") return true;
            const filePath = event.data?.path?.text;
            const lineNumber = event.data?.line_number;
            if (!filePath || typeof lineNumber !== "number") return true;
            // AND / exclude filters run on the matched line's text as streamed
            // by rg, so the limit counts final results, not pre-filter candidates.
            const text = typeof event.data?.lines?.text === "string" ? event.data.lines.text : "";
            if (!linePasses(text.replace(/\r?\n$/, ""))) return true;
            matchCount++;
            raw.push({ filePath, lineNumber });
            if (matchCount >= effectiveLimit) {
              matchLimitReached = true;
              return false;
            }
            return true;
          })
          .then(async ({ code, stderr, stopped }) => {
            if (signal?.aborted) {
              reject(new Error("Operation aborted"));
              return;
            }
            if (!stopped && code !== 0 && code !== 1) {
              reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
              return;
            }
            if (raw.length === 0) {
              resolvePromise({
                content: [{ type: "text", text: "No matches found" }],
                details: undefined,
              });
              return;
            }

            // Group by file, matches sorted by line number (Map keeps rg's discovery order).
            const byFile = new Map<string, number[]>();
            for (const m of raw) {
              const arr = byFile.get(m.filePath) ?? [];
              arr.push(m.lineNumber);
              byFile.set(m.filePath, arr);
            }
            for (const arr of byFile.values()) arr.sort((a, b) => a - b);

            // Read each file once and hash all its lines; hash is computed from the FULL line.
            const fileCache = new Map<string, { lines: string[]; hashes: string[] }>();
            const getFile = async (fp: string) => {
              let entry = fileCache.get(fp);
              if (!entry) {
                let content = "";
                try {
                  content = (await readFile(fp)).toString("utf-8");
                } catch {
                  content = "";
                }
                const lines = splitLines(content);
                entry = { lines, hashes: hashFileLines(lines, hashLen) };
                fileCache.set(fp, entry);
              }
              return entry;
            };

            const formatPath = (fp: string): string => {
              const abs = resolve(cwd, fp);
              const rel = relative(cwd, abs);
              return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
                ? rel.replace(/\\/g, "/")
                : abs;
            };

            const blocks: string[] = [];
            if (outputMode === "content") {
              for (const [fp, matchLines] of byFile) {
                const { lines, hashes } = await getFile(fp);
                // Context windows are rebuilt from surviving matches so context
                // lines of a filtered-out match never leak.
                const windowSet = new Set<number>();
                for (const ln of matchLines) {
                  for (let n = Math.max(1, ln - ctx); n <= Math.min(lines.length, ln + ctx); n++)
                    windowSet.add(n);
                }
                const header = `${formatPath(fp)} · ${matchLines.length} match${matchLines.length !== 1 ? "es" : ""}\n`;
                const rows: string[] = [];
                for (const n of [...windowSet].sort((a, b) => a - b)) {
                  const content = lines[n - 1] ?? "";
                  const hash = hashes[n - 1] ?? "";
                  const { text: disp, wasTruncated } = truncateLine(content.replace(/\r/g, ""));
                  if (wasTruncated) linesTruncated = true;
                  rows.push(`${n}#${hash}│${disp}`);
                }
                blocks.push(`${header}${rows.join("\n")}`);
              }
            } else if (outputMode === "files") {
              for (const fp of byFile.keys()) blocks.push(formatPath(fp));
            } else {
              // count
              let total = 0;
              for (const [fp, matchLines] of byFile) {
                blocks.push(`${formatPath(fp)}: ${matchLines.length}`);
                total += matchLines.length;
              }
              blocks.push(
                `Total: ${total} match${total !== 1 ? "es" : ""} in ${byFile.size} file${byFile.size !== 1 ? "s" : ""}`,
              );
            }

            let output = blocks.join(outputMode === "content" ? "\n\n" : "\n");
            const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES });
            output = truncation.content;

            const notices: string[] = [];
            if (matchLimitReached)
              notices.push(
                `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
              );
            if (truncation.truncated)
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
            if (linesTruncated)
              notices.push(
                `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read to see full lines`,
              );
            if (notices.length) output += `\n\n[${notices.join(". ")}]`;

            resolvePromise({
              content: [{ type: "text" as const, text: output }],
              details: undefined,
            });
          })
          .catch(reject);
      });
    },
  };
}
