/**
 * Serialize the local main conversation to reference text for peek consults.
 *
 * Inherited from pi-aside's design: pure function over SessionEntry[], with
 * length truncation so a single huge tool result can't blow up the utility
 * model's context.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PeekConfig } from "./types.ts";
import { DEFAULT_PEEK_CONFIG } from "./types.ts";

/** Serialize a session branch to peek reference text. */
export function serializeConversation(branch: SessionEntry[], config: PeekConfig = {}): string {
	const recentTurns = config.recentTurns ?? DEFAULT_PEEK_CONFIG.recentTurns;
	const maxChars = config.maxChars ?? DEFAULT_PEEK_CONFIG.maxChars;
	const toolResultLimit = config.toolResultLimit ?? DEFAULT_PEEK_CONFIG.toolResultLimit;

	// Only message entries participate.
	const messages = branch.filter((e) => e.type === "message");

	// Keep the most recent N user-led turns. A "turn" starts at a user message.
	const userStarts: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!.message as { role?: string };
		if (m.role === "user") userStarts.push(i);
	}
	const startIdx = userStarts.length > recentTurns ? userStarts[userStarts.length - recentTurns]! : 0;
	const recent = messages.slice(startIdx);

	const parts: string[] = [];
	for (const entry of recent) {
		parts.push(serializeMessage(entry, toolResultLimit));
	}

	let out = parts.join("\n").trim();
	if (out.length > maxChars) {
		const kept = out.slice(0, maxChars);
		out = kept + `\n\n[...truncated, ${out.length - maxChars} more chars omitted...]`;
	}
	return out || "(empty conversation)";
}

function serializeMessage(entry: SessionEntry, toolResultLimit: number): string {
	// entry is SessionMessageEntry here; message is AgentMessage (union).
	const msg = (entry as { message: any }).message as {
		role: string;
		content: any;
	};

	if (msg.role === "user") {
		const text = extractText(msg.content).trim();
		if (!text) return "";
		return `## user\n${text}\n`;
	}

	if (msg.role === "assistant") {
		const blocks: string[] = [];
		const content = Array.isArray(msg.content) ? msg.content : [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
				blocks.push(block.text);
			} else if (block.type === "toolCall") {
				blocks.push(`### tool: ${block.name}\n$ ${formatArgs(block.name, block.arguments)}`);
			}
			// thinking blocks are intentionally dropped (investigate needs conclusions, not reasoning).
		}
		if (blocks.length === 0) return "";
		return `## assistant\n${blocks.join("\n")}\n`;
	}

	if (msg.role === "toolResult") {
		const text = extractText(msg.content).trim();
		if (!text) return "";
		return `→ ${truncate(text, toolResultLimit)}\n`;
	}

	return "";
}

/** Pull text out of a content field that may be a string or a ContentBlock[]. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("\n");
	}
	return "";
}

/** Format tool call arguments concisely per known tool shapes. */
function formatArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash" && typeof args.command === "string") {
		return args.command.split("\n")[0]!.slice(0, 120);
	}
	if ((name === "read" || name === "write" || name === "edit") && typeof args.path === "string") {
		return args.path;
	}
	try {
		return truncate(JSON.stringify(args), 200);
	} catch {
		return "";
	}
}

/** Truncate to head + tail with a marker (head/tail split at the midpoint). */
function truncate(s: string, limit: number): string {
	if (s.length <= limit) return s;
	const half = Math.floor(limit / 2);
	const omitted = s.length - limit;
	return `${s.slice(0, half)}\n[...truncated ${omitted} chars...]\n${s.slice(-half)}`;
}
