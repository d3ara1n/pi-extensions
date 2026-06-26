/**
 * Spawn a pi child process and collect structured output with real-time progress.
 *
 * Uses pi's --mode json to get a JSON event stream.
 * Collects all messages (assistant + tool results) for TUI rendering.
 * Fires onProgress on each event for streaming updates.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentMessage, SubagentResult } from "./types.ts";

/** Maximum task length before writing to a temp file (avoids CLI arg limits). */
const TASK_CHAR_LIMIT = 8000;


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
		depth?: number;
		maxTurns?: number;
		maxCost?: number;
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
		activityLog: [],
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
		let budgetExceeded = false;
		let wasTimeout = false;
		let buffer = "";

		const emitProgress = () => {
			options.onProgress?.({
				output: result.output,
				messages: [...result.messages],
				usage: { ...result.usage },
				model: result.model,
				stopReason: result.stopReason,
				activityLog: result.activityLog.map((a) => ({ ...a })),
			});
		};

		let thinkingCounter = 0;
		// O(1) lookup from toolCallId → activityLog index (was linear find → O(n²) on busy runs)
		const toolCallIndex = new Map<string, number>();

		// Kill the child when the configured turn/cost budget is exceeded.
		// Called after each assistant message_end (usage already accumulated).
		const checkBudget = () => {
			const mt = options.maxTurns ?? 0;
			const mc = options.maxCost ?? 0;
			if (budgetExceeded || wasTimeout) return;
			if ((mt > 0 && result.usage.turns >= mt) || (mc > 0 && result.usage.cost >= mc)) {
				budgetExceeded = true;
				killProc("budget");
			}
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
						// Peak context size, not last-turn size (accumulating is meaningless; max tells how close to the limit)
						result.usage.contextTokens = Math.max(result.usage.contextTokens, usage.totalTokens || 0);
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

					checkBudget();
				}

				emitProgress();
			}

			// Activity log: track thinking blocks and tool calls in arrival order.
			// Both update in place so the TUI reflects real-time state.
			if (event.type === "tool_execution_start" && event.toolCallId) {
				toolCallIndex.set(event.toolCallId, result.activityLog.length);
				result.activityLog.push({
					kind: "toolCall",
					id: event.toolCallId,
					status: "running",
					toolName: event.toolName,
					args: event.args ?? {},
				});
				emitProgress();
			} else if (event.type === "tool_execution_end" && event.toolCallId) {
				const idx = toolCallIndex.get(event.toolCallId);
				if (idx !== undefined) result.activityLog[idx].status = event.isError ? "failed" : "done";
				emitProgress();
			}

			// Thinking-block lifecycle: pi wraps thinking_start/end inside
			// message_update.assistantMessageEvent. These arrive BEFORE message_end,
			// so we can't rely on messages[] to show real-time thinking state —
			// register them in the activity log directly.
			const aev = event.assistantMessageEvent;
			if (event.type === "message_update" && aev) {
				if (aev.type === "thinking_start") {
					result.activityLog.push({
						kind: "thinking",
						id: `thinking-${thinkingCounter++}`,
						status: "running",
					});
					emitProgress();
				} else if (aev.type === "thinking_end") {
					// Mark the most recent still-running thinking block as done.
					for (let i = result.activityLog.length - 1; i >= 0; i--) {
						if (result.activityLog[i].kind === "thinking" && result.activityLog[i].status === "running") {
							result.activityLog[i].status = "done";
							break;
						}
					}
					emitProgress();
				}
			}
		};

		// Build env with optional subagent allowlist and tmpdir for researcher role
		const childEnv: NodeJS.ProcessEnv = { ...process.env };
		if (options.subagentRoles && options.subagentRoles.length > 0) {
			childEnv.PI_SUBAGENT_ALLOWED = options.subagentRoles.join(",");
		}
		// Expose tmpdir as env var so subagent bash commands (e.g. git clone) can use it
		childEnv.PI_SUBAGENT_TMPDIR = tmpDir;
		// Propagate nesting depth so child delegate calls can bound recursion
		childEnv.PI_SUBAGENT_DEPTH = String(options.depth ?? 0);

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let proc: ChildProcess | undefined;

		// Shared kill helper used by abort, budget, and timeout paths.
		// Centralizes reason → stopReason mapping and the SIGTERM → 5s → SIGKILL escalation.
		const escalationTimers: ReturnType<typeof setTimeout>[] = [];
		const killProc = (reason: "abort" | "budget" | "timeout") => {
			if (reason === "abort") wasAborted = true;
			else if (reason === "budget") {
				result.stopReason = "budget_exceeded";
				// Human-readable so the caller/TUI never falls back to raw stderr noise.
				const mt = options.maxTurns ?? 0;
				const mc = options.maxCost ?? 0;
				const why = mt > 0 && result.usage.turns >= mt ? `${result.usage.turns} turns` : `$${result.usage.cost.toFixed(4)}`;
				result.errorMessage = `Budget exceeded (${why}; partial output returned)`;
			}
			else if (reason === "timeout") {
				result.stopReason = "timeout";
				wasTimeout = true;
				// Human-readable message so the caller/TUI never falls back to the
				// raw stderr (which is full of TUI teardown escape sequences).
				const secs = Math.round((options.timeoutMs ?? 0) / 1000);
				result.errorMessage = `Timed out after ${secs}s (completed ${result.usage.turns} turn${result.usage.turns === 1 ? "" : "s"})`;
			}
			try { proc?.kill("SIGTERM"); } catch { /* ignore */ }
			escalationTimers.push(setTimeout(() => {
				try { if (proc && !proc.killed) proc.kill("SIGKILL"); } catch { /* ignore */ }
			}, 5000));
		};

		const exitCode = await new Promise<number>((resolve) => {
			// Register abort BEFORE spawning to close the (tiny) registration window
			let onAbort: (() => void) | undefined;
			if (options.signal) {
				if (options.signal.aborted) { wasAborted = true; resolve(0); return; }
				onAbort = () => killProc("abort");
				options.signal.addEventListener("abort", onAbort, { once: true });
			}

			const p = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				env: childEnv,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			proc = p;

			p.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			p.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});

			p.on("close", (code, signal) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				for (const t of escalationTimers) clearTimeout(t);
				if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
				if (buffer.trim()) processLine(buffer);

				// External signal death (OOM killer, segfault, kill -9 from elsewhere)
				// that we didn't trigger. Distinguish from our own budget/timeout/abort kills
				// which set the flags before we send the signal.
				const externalKill = signal !== null && !budgetExceeded && !wasTimeout && !wasAborted;
				if (externalKill) {
					result.errorMessage = result.errorMessage || `Subagent killed by signal ${signal}`;
					result.stopReason = "error";
				}

				// Budget stops are intentional (success); timeouts and external kills
				// are failures (non-zero); otherwise use the real exit code.
				resolve(budgetExceeded ? 0 : (wasTimeout || externalKill ? (code ?? 128) : (code ?? 0)));
			});

			p.on("error", (err) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				for (const t of escalationTimers) clearTimeout(t);
				if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
				// Surface the real cause (e.g. ENOENT when pi is not in PATH) instead of "unknown error".
				result.errorMessage = err?.message || String(err);
				resolve(1);
			});

			// Handle timeout
			if (options.timeoutMs && options.timeoutMs > 0) {
				timeoutHandle = setTimeout(() => killProc("timeout"), options.timeoutMs);
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		// NOTE: large outputs are kept raw here — compression/truncation happens in
		// the extension layer (index.ts) so the summary model can compress first.
	} finally {
		// Cleanup temp directory and all contents
		if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}

	return result;
}
