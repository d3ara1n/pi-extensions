import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface RecordItem {
  kind: string;
  text: string;
  thinking: string;
}

/** @internal Snapshot of the session's active context view; never holds references to mutable session entries. */
export class SessionSnapshot {
  readonly capturedAt: string;
  private records: RecordItem[] = [];

  constructor(entries: readonly SessionEntry[], capturedAt = new Date().toISOString()) {
    this.capturedAt = capturedAt;
    for (const entry of entries) {
      if (entry.type === "message") {
        this.addMessage(entry.message);
      } else if (entry.type === "custom_message") {
        this.addMessage({ ...entry, role: "custom" });
      } else if (entry.type === "compaction" || entry.type === "branch_summary") {
        this.records.push({ kind: entry.type, text: entry.summary, thinking: "" });
        if (entry.type === "compaction" && "retainedTail" in entry && Array.isArray(entry.retainedTail)) {
          entry.retainedTail.forEach(message => this.addMessage(message));
        }
      }
    }
  }

  private addMessage(value: unknown): void {
    const m = value as Record<string, any>;
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    const thinking = blocks.filter(b => b?.type === "thinking" && !b.redacted && typeof b.thinking === "string")
      .map(b => b.thinking).filter(Boolean).join("\n");
    const parts: string[] = [];
    if (m.timestamp !== undefined) parts.push(`Timestamp: ${m.timestamp}`);
    if (typeof m.content === "string") parts.push(m.content);
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      if (block?.type === "toolCall") {
        parts.push(`Tool call ${block.id}: ${block.name}\nArguments: ${JSON.stringify(block.arguments)}`);
      }
      if (block?.type === "image") parts.push("[Image not included.]");
    }
    if (m.role === "toolResult") {
      parts.unshift(`Tool result ${m.toolCallId}: ${m.toolName}; isError=${Boolean(m.isError)}`);
      // Render-only patch evidence may not be duplicated in content.
      for (const key of ["diff", "patch", "fullOutputPath", "truncated"]) {
        if (m.details?.[key] !== undefined) parts.push(`${key}: ${JSON.stringify(m.details[key])}`);
      }
      if (Array.isArray(m.details?.files)) {
        for (const file of m.details.files) {
          if (!file || typeof file !== "object") continue;
          const evidence: Record<string, unknown> = {};
          for (const key of ["path", "moveTo", "kind", "diff", "patch", "added", "removed"]) {
            if (typeof file[key] === "string" || typeof file[key] === "number") evidence[key] = file[key];
          }
          if (Object.keys(evidence).length) parts.push(`File evidence: ${JSON.stringify(evidence)}`);
        }
      }
    }
    if (m.role === "assistant") {
      parts.unshift(`Model: ${m.provider ?? "unknown"}/${m.model ?? "unknown"}; stopReason=${m.stopReason ?? "unknown"}`);
      if (m.errorMessage) parts.push(`Error: ${m.errorMessage}`);
    }
    if (m.role === "bashExecution") {
      parts.push(`Command: ${m.command}\nOutput: ${m.output}\nexitCode=${m.exitCode}; cancelled=${m.cancelled}; truncated=${m.truncated}; excludeFromContext=${m.excludeFromContext}`);
    }
    if (typeof m.summary === "string") parts.push(m.summary);
    if (m.customType) parts.unshift(`Extension message: ${m.customType}; display=${m.display}`);
    this.records.push({ kind: String(m.role ?? "unknown"), text: parts.join("\n"), thinking });
  }

  reference(includeThinking = false): string {
    const header = [
      "Scope: the session's active context view — the compaction summary plus everything kept after it; exactly what the session's main assistant currently sees. Capture time is supplied with the question.",
      "The compaction summary may overlap the retained messages that follow it.",
      includeThinking
        ? "Readable saved thinking is included where available; missing/redacted thinking cannot be reconstructed."
        : "Thinking is not included.",
      "Images, the main system prompt, other branches and external files/logs are not included.",
    ].join("\n");
    const records = this.records.map(r => {
      const thinking = includeThinking && r.thinking ? `\nSaved thinking:\n${r.thinking}` : "";
      return `[${r.kind}]\n${r.text}${thinking}`;
    }).join("\n\n");
    return `${header}\n\n${records || "(empty conversation)"}`;
  }

  dispose(): void {
    this.records = [];
  }
}
