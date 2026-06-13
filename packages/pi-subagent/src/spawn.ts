/**
 * Spawn a pi child process and collect structured output with real-time progress.
 *
 * Uses pi's --mode json to get a JSON event stream.
 * Collects all messages (assistant + tool results) for TUI rendering.
 * Fires onProgress on each event for streaming updates.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentMessage, SubagentResult } from "./types.ts";

/** Maximum task length before writing to a temp file (avoids CLI arg limits). */
const TASK_CHAR_LIMIT = 8000;

/** Maximum output characters returned to the main model. Larger outputs are truncated. */
const MAX_OUTPUT_CHARS = 50_000;

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

function isRunnableScript(filePath: string): boolean {
	try {
		if (!fs.existsSync(filePath)) return false;
		return /\.(?:mjs|cjs|js)$/i.test(filePath);
	} catch {
		return false;
	}
}

function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: unknown };
				if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
			} catch {
				/* ignore */
			}
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

function resolveWindowsPiCliScript(args: string[]): { command: string; args: string[] } | undefined {
	// Strategy 1: Use process.argv[1] if it's a runnable script
	// (works when pi is run via `bun pi` or `bunx pi` — argv[1] is the real CLI path)
	const argv1 = process.argv[1];
	if (argv1) {
		const argvPath = path.isAbsolute(argv1) ? argv1 : path.resolve(argv1);
		if (isRunnableScript(argvPath)) {
			return { command: process.execPath, args: [argvPath, ...args] };
		}
	}

	// Strategy 2: Resolve pi-coding-agent package via import.meta.resolve,
	// then read the bin field from its package.json
	try {
		const resolved = fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE));
		const root = findPiPackageRootFromEntry(resolved);
		if (root) {
			const pkgPath = path.join(root, "package.json");
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
				bin?: string | Record<string, string>;
			};
			const binField = pkg.bin;
			const binPath =
				typeof binField === "string"
					? binField
					: binField?.pi ?? Object.values(binField ?? {})[0];
			if (binPath) {
				const candidate = path.resolve(root, binPath);
				if (isRunnableScript(candidate)) {
					return { command: process.execPath, args: [candidate, ...args] };
				}
			}
		}
	} catch {
		/* fall through */
	}

	return undefined;
}

/**
 * Determine how to invoke pi.
 *
 * On Windows, attempts to find the pi CLI script via:
 *   1. process.argv[1] (when run via `bun pi` or `bunx pi`)
 *   2. import.meta.resolve of @earendil-works/pi-coding-agent → bin field
 * If found, spawns process.execPath (bun) with the script path.
 * Falls back to `pi` from PATH if neither works.
 *
 * On non-Windows, always uses the `pi` CLI command from PATH.
 *
 * This avoids the standalone compiled pi.exe's process.execPath
 * (virtual Bun path like B:/~BUN/root/pi.exe) ever being passed
 * to the child process, while still working when `pi` is not in PATH.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	if (process.platform === "win32") {
		const winResult = resolveWindowsPiCliScript(args);
		if (winResult) return winResult;
	}
	return { command: "pi", args };
}

/**
 * Spawn a pi child process with the given model and configuration.
 * Fires onProgress on each JSON event for streaming TUI updates.
 *
 * @param modelRef - Model identifier like "deepseek/deepseek-v4-flash"
 * @param task - The task prompt
 * @param options - Spawn options
 * @returns SubagentResult with collected messages and usage stats
 */
export async function spawnSubagent(
	modelRef: string,
	task: string,
	options: {
		cwd?: string;
		tools?: string[];
		systemPrompt?: string;
		subagentRoles?: string[];
		timeoutMs?: number;
		signal?: AbortSignal;
		onProgress?: (update: Partial<SubagentResult>) => void;
	},
): Promise<SubagentResult> {
	const result: SubagentResult = {
		role: "",
		task,
		exitCode: 0,
		messages: [],
		output: "",
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		toolStatuses: {},
	};

	let tmpDir: string | null = null;
	let tmpFile: string | null = null;

	try {
		// Build CLI args
		const args: string[] = ["--mode", "json", "--no-session", "--model", modelRef];

		if (options.tools && options.tools.length > 0) {
			args.push("--tools", options.tools.join(","));
		}

		// Always create temp dir — used for prompt file, long task file, and as PI_SUBAGENT_TMPDIR for subagent work (e.g. git clone)
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));

		const promptContent = options.systemPrompt?.trim()
			? options.systemPrompt + `\n\nPI_SUBAGENT_TMPDIR=${tmpDir}`
			: `PI_SUBAGENT_TMPDIR=${tmpDir}`;
		tmpFile = path.join(tmpDir, "prompt.md");
		await fs.promises.writeFile(tmpFile, promptContent, { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", tmpFile);

		if (task.length > TASK_CHAR_LIMIT) {
			const taskPath = path.join(tmpDir, "task.md");
			await fs.promises.writeFile(taskPath, task, { encoding: "utf-8", mode: 0o600 });
			args.push(`@${taskPath}`);
		} else {
			args.push(`Task: ${task}`);
		}

		// Spawn process
		const invocation = getPiInvocation(args);
		let wasAborted = false;
		let buffer = "";

		const emitProgress = () => {
			options.onProgress?.({
				output: result.output,
				messages: [...result.messages],
				usage: { ...result.usage },
				model: result.model,
				stopReason: result.stopReason,
				toolStatuses: { ...result.toolStatuses },
			});
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				const msg = event.message as SubagentMessage;
				result.messages.push(msg);

				if (msg.role === "assistant") {
					result.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += usage.cost?.total || 0;
						result.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!result.model && msg.model) result.model = msg.model;
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;

					// Track last assistant text
					for (const part of msg.content) {
						if (part.type === "text" && part.text) {
							result.output = part.text;
						}
					}
				}

				emitProgress();
			}

			// Per-tool-call lifecycle: track running/done/failed by toolCallId.
			// pi emits these via the JSON event stream (session.subscribe re-emits
			// agent events verbatim). tool_execution_end carries isError.
			if (event.type === "tool_execution_start" && event.toolCallId) {
				result.toolStatuses[event.toolCallId] = "running";
				emitProgress();
			} else if (event.type === "tool_execution_end" && event.toolCallId) {
				result.toolStatuses[event.toolCallId] = event.isError ? "failed" : "done";
				emitProgress();
			}
		};

		// Build env with optional subagent allowlist and tmpdir for researcher role
		const childEnv: NodeJS.ProcessEnv = { ...process.env };
		if (options.subagentRoles && options.subagentRoles.length > 0) {
			childEnv.PI_SUBAGENT_ALLOWED = options.subagentRoles.join(",");
		}
		// Expose tmpdir as env var so subagent bash commands (e.g. git clone) can use it
		childEnv.PI_SUBAGENT_TMPDIR = tmpDir;

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				env: childEnv,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			// Handle abort signal
			if (options.signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (options.signal.aborted) killProc();
				else options.signal.addEventListener("abort", killProc, { once: true });
			}

			// Handle timeout
			if (options.timeoutMs && options.timeoutMs > 0) {
				timeoutHandle = setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGTERM");
						setTimeout(() => {
							if (!proc.killed) proc.kill("SIGKILL");
						}, 5000);
					}
				}, options.timeoutMs);
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");

		// Truncate large outputs: keep head (findings) + tail (summary), drop middle
		if (result.output.length > MAX_OUTPUT_CHARS) {
			const head = result.output.slice(0, 30_000);
			const tail = result.output.slice(-(MAX_OUTPUT_CHARS - 30_050));
			result.output = `[Output truncated — ${result.output.length} chars total]\n\n${head}\n\n... [truncated] ...\n\n${tail}`;
		}
	} finally {
		// Cleanup temp directory and all contents
		if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}

	return result;
}
