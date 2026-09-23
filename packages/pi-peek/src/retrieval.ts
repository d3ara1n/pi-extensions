import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionSnapshot } from "./snapshot.ts";

/** @internal Tools supplied only to the investigation model, never registered on the main agent. */
export const INVESTIGATION_TOOLS: Tool[] = [
  {
    name: "search_session",
    description:
      "Search all snapshot records, including those omitted from the outline. Literal, case-insensitive match; returns IDs, one excerpt per record, and nextCursor.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Consecutive text to find, in order — not a keyword list.",
        },
        cursor: {
          type: "integer",
          minimum: 0,
          description: "nextCursor from a previous search; defaults to 0.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum matching records; defaults to 8.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_session",
    description:
      "Read saved content by record ID, including tool arguments and results. Returns bounded pages with nextOffset; does not open external files.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ids: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", maxLength: 32 } },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "UTF-16 character offset within each record; defaults to 0. Use nextOffset to continue.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 12000,
          description: "Combined character budget across the records; defaults to 8000.",
        },
      },
      required: ["ids"],
    },
  },
];

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`Expected an integer from ${min} to ${max}.`);
  return value as number;
}

/** @internal Invalid tool requests become recoverable tool errors, with no external side effects. */
export function executeSnapshotTool(snapshot: SessionSnapshot, call: ToolCall): ToolResultMessage {
  let text: string;
  let isError = false;
  try {
    const args = call.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("Expected an arguments object.");
    const allowed =
      call.name === "search_session"
        ? ["query", "cursor", "limit"]
        : call.name === "read_session"
          ? ["ids", "offset", "limit"]
          : [];
    if (Object.keys(args).some((key) => !allowed.includes(key)))
      throw new Error("Unexpected tool argument.");
    if (call.name === "search_session") {
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 256)
        throw new Error("query must be a nonempty string of at most 256 characters.");
      text = JSON.stringify(
        snapshot.search(
          args.query,
          integer(args.cursor, 0, 0, Number.MAX_SAFE_INTEGER),
          integer(args.limit, 8, 1, 20),
        ),
      );
    } else if (call.name === "read_session") {
      if (
        !Array.isArray(args.ids) ||
        args.ids.length < 1 ||
        args.ids.length > 4 ||
        args.ids.some((id) => typeof id !== "string" || !/^[A-Z]\d{1,10}$/.test(id))
      )
        throw new Error("ids must contain 1–4 snapshot record IDs.");
      text = JSON.stringify(
        snapshot.read(
          args.ids,
          integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
          integer(args.limit, 8000, 1, 12000),
        ),
      );
    } else {
      throw new Error("Unknown investigation tool. Use search_session or read_session.");
    }
  } catch (error) {
    isError = true;
    text = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}
