import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTextTokens, textPrefix } from "./budget.ts";

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
        if (m.errorMessage) add("A", "assistant_error", String(m.errorMessage), true, time);
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
          true,
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

  /** A bounded outline; omitted bodies and older records remain searchable/readable. */
  outline(maxTokens: number): string {
    const header = `${SCOPE}\nSource thinking: ${this.includeThinking ? "readable saved blocks only" : "excluded"}.\nRecords: ${this.records.length}. The outline may omit or abbreviate records.\n`;
    const selected = new Map<RecordItem, string>();
    let remaining = maxTokens - estimateTextTokens(header) - 100;
    const select = (record: RecordItem, allowance: number) => {
      const rendered = this.preview(record, allowance);
      const cost = estimateTextTokens(rendered) + 2;
      if (cost > remaining || cost > allowance) return false;
      selected.set(record, rendered);
      remaining -= cost;
      return true;
    };
    // Preserve task anchors before long recent dialogue can exhaust the outline.
    const anchors = [
      this.records.findLast((r) => r.kind === "user"),
      this.records.findLast((r) => r.kind === "compactionSummary"),
      this.records.find((r) => r.kind === "user"),
    ];
    for (const record of anchors) {
      if (record && !selected.has(record) && remaining > 100) {
        select(record, Math.min(2000, Math.floor(remaining / 4)));
      }
    }
    // Reserve a compact reference sample even when tool calls are followed by long prose.
    let referenceBudget = Math.floor(remaining / 3);
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]!;
      if (record.inline) continue;
      const before = remaining;
      if (select(record, referenceBudget)) referenceBudget -= before - remaining;
    }
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]!;
      if (!selected.has(record) && remaining >= 80) select(record, Math.min(2000, remaining));
    }
    const omitted = this.records.length - selected.size;
    const body = this.records
      .flatMap((record) => (selected.has(record) ? [selected.get(record)!] : []))
      .join("\n\n");
    return textPrefix(
      `${header}${omitted ? `\n[${omitted} records omitted from this outline; search the snapshot to locate them.]\n` : ""}\n${body || "(no records fit this outline; use search_session)"}`,
      maxTokens,
    );
  }

  private preview(record: RecordItem, tokens: number): string {
    if (!record.inline) return record.label;
    const budget = Math.max(0, tokens - estimateTextTokens(record.label) - 40);
    const body = textPrefix(record.text, budget);
    return `${record.label}\n${body}${body.length < record.text.length ? `\n[Body abbreviated; read_session id=${record.id}.]` : ""}`;
  }

  /** Full admitted text for explicit local serialization; investigations use outline(). */
  reference(): string {
    return `${SCOPE}\n\n${this.records.map((r) => `${r.label}\n${r.text}`).join("\n\n") || "(empty conversation)"}`;
  }

  read(ids: string[], offset = 0, limit = 8000): object {
    const pages = [];
    let remaining = Math.min(12000, limit);
    const requested = ids.slice(0, 4);
    for (const [index, id] of requested.entries()) {
      const record = this.byId.get(id);
      if (!record) {
        pages.push({ id, error: "Unknown or unavailable record." });
        continue;
      }
      const allowance = Math.ceil(remaining / (requested.length - index));
      const text = record.text.slice(offset, offset + allowance);
      const end = offset + text.length;
      pages.push({
        id,
        label: record.label,
        offset,
        totalChars: record.text.length,
        text,
        nextOffset: end < record.text.length ? end : null,
      });
      remaining -= text.length;
    }
    return {
      records: pages,
    };
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
