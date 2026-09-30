import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ProjectedMessages = ReturnType<
  ExtensionContext["sessionManager"]["buildSessionProjection"]
>["messages"];
interface RecordItem {
  id: string;
  kind: string;
  label: string;
  text: string;
  inline: boolean;
}

const SCOPE =
  "Source: the current branch after compaction and context edits; request-time transforms are not applied. System prompts and private extension state are excluded.";

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((b) =>
      b?.type === "text" && typeof b.text === "string"
        ? [b.text]
        : b?.type === "image"
          ? ["[Image not included.]"]
          : [],
    )
    .join("\n");
}

function evidence(details: any): string {
  const parts: string[] = [];
  for (const key of ["diff", "patch", "fullOutputPath", "truncated"]) {
    if (details?.[key] !== undefined) parts.push(`${key}: ${JSON.stringify(details[key])}`);
  }
  if (Array.isArray(details?.files)) {
    for (const file of details.files) {
      if (!file || typeof file !== "object") continue;
      const allowed: Record<string, unknown> = {};
      for (const key of ["path", "moveTo", "kind", "diff", "patch", "added", "removed"]) {
        if (typeof file[key] === "string" || typeof file[key] === "number")
          allowed[key] = file[key];
      }
      if (Object.keys(allowed).length) parts.push(`File evidence: ${JSON.stringify(allowed)}`);
    }
  }
  return parts.join("\n");
}

/** @internal Immutable, searchable snapshot. Thinking is admitted only at construction. */
export class SessionSnapshot {
  readonly capturedAt: string;
  private records: RecordItem[] = [];
  private byId = new Map<string, RecordItem>();
  private readonly includeThinking: boolean;

  constructor(
    messages: ProjectedMessages,
    options: { includeThinking?: boolean; capturedAt?: string } = {},
  ) {
    this.capturedAt = options.capturedAt ?? new Date().toISOString();
    this.includeThinking = options.includeThinking === true;
    const pending = new Map<string, RecordItem[]>();
    const counters = new Map<string, number>();
    const add = (prefix: string, kind: string, text: string, inline: boolean, meta = "") => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      const id = `${prefix}${n}`;
      const record = { id, kind, text, inline, label: `[${kind} id=${id}${meta}]` };
      this.records.push(record);
      this.byId.set(id, record);
      return record;
    };
    for (const value of messages) {
      const m = value as any;
      const time = m.timestamp === undefined ? "" : ` timestamp=${JSON.stringify(m.timestamp)}`;
      if (m.role === "system" || (m.role === "bashExecution" && m.excludeFromContext)) continue;
      if (m.role === "assistant") {
        for (const block of Array.isArray(m.content) ? m.content : []) {
          if (block?.type === "text" && typeof block.text === "string")
            add("A", "assistant", block.text, true, time);
          else if (
            block?.type === "thinking" &&
            this.includeThinking &&
            !block.redacted &&
            typeof block.thinking === "string" &&
            block.thinking
          ) {
            add("H", "thinking", block.thinking, false, time);
          } else if (block?.type === "toolCall") {
            const record = add(
              "T",
              "toolcall",
              `Tool: ${block.name}\nCall ID: ${block.id}\nArguments: ${JSON.stringify(block.arguments)}\nResult: pending at capture.`,
              false,
              ` name=${JSON.stringify(String(block.name))} status=pending${time}`,
            );
            const queue = pending.get(block.id) ?? [];
            queue.push(record);
            pending.set(block.id, queue);
          }
        }
        if (m.errorMessage) add("A", "assistant_error", String(m.errorMessage), false, time);
      } else if (m.role === "toolResult") {
        const result =
          `Result${m.isError ? " (error)" : ""}:\n${contentText(m.content)}\n${evidence(m.details)}`.trimEnd();
        const queue = pending.get(m.toolCallId);
        const record = queue?.shift();
        if (record) {
          record.text = record.text.replace(/\nResult: pending at capture\.$/, () => `\n${result}`);
          record.label = record.label.replace(
            "status=pending",
            `status=${m.isError ? "error" : "complete"}`,
          );
          if (!queue?.length) pending.delete(m.toolCallId);
        } else {
          add(
            "T",
            "toolresult",
            `Tool: ${m.toolName}\nCall ID: ${m.toolCallId}\n${result}`,
            false,
            ` name=${JSON.stringify(String(m.toolName))} status=${m.isError ? "error" : "complete"}${time}`,
          );
        }
      } else if (m.role === "user") {
        add("U", "user", contentText(m.content), true, time);
      } else if (m.role === "custom") {
        add(
          "C",
          "context",
          contentText(m.content),
          false,
          ` type=${JSON.stringify(m.customType)}${time}`,
        );
      } else if (m.role === "compactionSummary" || m.role === "branchSummary") {
        add("S", m.role, String(m.summary ?? ""), true, time);
      } else if (m.role === "bashExecution") {
        add(
          "T",
          "shell",
          `Command: ${m.command}\nOutput: ${m.output}\nexitCode=${m.exitCode}; cancelled=${m.cancelled}; truncated=${m.truncated}`,
          false,
          time,
        );
      }
    }
  }

  /** Complete dialogue and summaries, with retrieval labels for all other admitted blocks. */
  outline(): string {
    const header = `${SCOPE}\nSource thinking: ${this.includeThinking ? "readable saved blocks only" : "excluded"}.\nRecords: ${this.records.length}. Dialogue and summaries are included in full; other blocks are represented by retrieval labels.\n`;
    const body = this.records
      .map((record) => (record.inline ? `${record.label}\n${record.text}` : record.label))
      .join("\n\n");
    return `${header}\n${body || "(empty conversation)"}`;
  }

  /** Full admitted text for explicit local serialization; investigations use outline(). */
  reference(): string {
    return `${SCOPE}\n\n${this.records.map((r) => `${r.label}\n${r.text}`).join("\n\n") || "(empty conversation)"}`;
  }

  read(ids: string[]) {
    return {
      records: ids.map((id) => {
        const record = this.byId.get(id);
        return record
          ? { id, label: record.label, text: record.text }
          : { id, error: "Unknown or unavailable record." };
      }),
    };
  }

  /** Inclusive range in snapshot order, spanning any admitted block kinds. */
  readRange(startId: string, endId: string) {
    const start = this.records.findIndex((record) => record.id === startId);
    const end = this.records.findIndex((record) => record.id === endId);
    if (start < 0 || end < 0) throw new Error("Unknown or unavailable range endpoint.");
    if (end < start) throw new Error("endId must follow or equal startId in snapshot order.");
    return this.read(this.records.slice(start, end + 1).map((record) => record.id));
  }

  search(query: string, cursor = 0, limit = 8): object {
    const needle = query.toLowerCase();
    const matches = [];
    let index = cursor;
    for (; index < this.records.length && matches.length < Math.min(20, limit); index++) {
      const record = this.records[index]!;
      const haystack = `${record.label}\n${record.text}`;
      const match = haystack.toLowerCase().indexOf(needle);
      if (match < 0) continue;
      const start = Math.max(0, match - 100);
      matches.push({
        id: record.id,
        label: record.label,
        excerpt: haystack.slice(start, match + needle.length + 250),
      });
    }
    return {
      matches,
      nextCursor: index < this.records.length ? index : null,
    };
  }

  dispose(): void {
    this.records = [];
    this.byId.clear();
  }
}
