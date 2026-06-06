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
import type { SubagentMessage, SubagentResult } from "./types.ts";

/** Maximum task length before writing to a temp file (avoids CLI arg limits). */
const TASK_CHAR_LIMIT = 8000;

/** Maximum output characters returned to the main model. Larger outputs are truncated. */
const MAX_OUTPUT_CHARS = 50_000;

/** Determine how to invoke pi.
 *
 * Always uses the `pi` CLI command. On Windows with Bun-compiled pi,
 * process.execPath returns a virtual path (B:/~BUN/root/pi.exe) that
 * leaks into the child model's context and causes it to run stray
 * diagnostic commands. Using the `pi` command from PATH avoids this.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

			if (event.type === "tool_result_end" && event.message) {
				result.messages.push(event.message as SubagentMessage);
				emitProgress();
			}
		};

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
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
				setTimeout(() => {
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
