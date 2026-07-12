/**
 * History persistence for pi-subagent delegate runs.
 *
 * Best-effort audit log: writes one JSON record per delegate run under
 * ~/.pi/subagent/history/{sessionId}/{toolCallId}.json. Never throws — persistence
 * must not fail the delegation. Privacy parity with pi's own session files.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentResult } from "./types.ts";
import { sanitizeFilename } from "./utils.ts";

export function persistSubagentHistory(
  sessionId: string | undefined,
  toolCallId: string,
  role: string,
  task: string,
  r: SubagentResult,
  rawOutput?: string,
): void {
  try {
    const dir = path.join(
      os.homedir(),
      ".pi",
      "subagent",
      "history",
      sanitizeFilename(sessionId ?? "unknown"),
    );
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      id: toolCallId,
      role,
      task,
      timestamp: Date.now(),
      exitCode: r.exitCode,
      stopReason: r.stopReason,
      model: r.model,
      summary: r.summary,
      // Keep the full original output for auditing even if LLM/TUI saw a compressed/truncated version.
      output: rawOutput ?? r.output,
      outputMethod: r.outputMethod,
      errorMessage: r.errorMessage,
      usage: r.usage,
      activityLog: r.activityLog,
    };
    fs.writeFileSync(
      path.join(dir, `${sanitizeFilename(toolCallId)}.json`),
      JSON.stringify(payload, null, 2),
      { mode: 0o600 },
    );
  } catch {
    /* best-effort — never fail the delegation */
  }
}
