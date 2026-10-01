/**
 * pi-chat-room tool — `send_to`, the agent-to-agent messaging surface.
 *
 * One tool: send_to({ name, message }) delivers a message to a named peer.
 * Delivery is asynchronous: it resolves once the recipient's mesh acknowledges
 * receipt (the recipient has queued the message as a user message), NOT when
 * the recipient agent reads or replies. Any reply arrives as a [From: NAME]
 * user message after the recipient's turn ends, starting a new turn.
 *
 * The promptGuidelines below encode the OUTPUT DUAL-CHANNEL rule: an agent's
 * normal output goes to the human user; addressing another agent REQUIRES
 * send_to. This is the only way to keep multi-agent routing reliable, since
 * LLMs have no native notion of addressing one audience vs another in a single
 * output stream.
 *
 * Rendering follows the built-in tool convention (same as peek): the call cell
 * shows the tool name + recipient; the result cell shows a message summary
 * when collapsed and the full message body when expanded.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getMeshAPI } from "@d3ara1n/pi-mesh";
import type { PeerInfo } from "@d3ara1n/pi-mesh";
import { MESSAGE_TYPE } from "./types.ts";

export function registerChatRoomTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "send_to",
    label: "Message another agent",
    description:
      "Send a message to another pi instance on the agent mesh. The recipient's agent receives it as a user message prefixed [From: <your name>], reads it, and can act or reply. " +
      "Use this to address another agent directly — your normal output is seen by the human user, not by other agents. " +
      "Delivery is asynchronous: this returns once the recipient's mesh acknowledges receipt, NOT when the recipient agent reads or replies; the reply arrives as a [From: ...] user message after your current turn ends, starting a new turn. " +
      "Use mesh_list first to discover names. Direct tool call only — not callable from codemode scripts: it is absent from the script's `tools` object.",
    promptSnippet: "Send a message to another pi agent on the mesh",
    promptGuidelines: [
      "Use send_to to address another agent on the mesh; your normal output is seen by the human user only, never by other agents.",
      "Messages from other agents arrive as user text prefixed [From: NAME]; reply to their content with send_to(name=NAME, ...), not in your normal output.",
      "send_to returns once the recipient's mesh acknowledges delivery — it does not wait for the recipient to read or reply. The reply arrives as a [From: NAME] user message after your current turn ends, starting a new turn.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Recipient's mesh name (as shown by mesh_list)." }),
      message: Type.String({ description: "The message body to deliver." }),
    }),
    // Model-only: addressing another agent is a top-level decision with external side effects,
    // and the reply only arrives as a [From: ...] user message after the turn ends — a codemode
    // script could never consume it. Batch parallel top-level send_to calls instead.
    exposure: "model-only",

    // Call cell: tool name + recipient (the message body appears in the result cell).
    renderCall(args, theme) {
      const target = (args as any).name ? ` → ${(args as any).name}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("send_to")) + theme.fg("accent", target),
        0,
        0,
      );
    },

    // Result cell: NO tool name. Collapsed = message summary (first line); expanded = full message body.
    renderResult(result, { expanded }, theme, context) {
      const isError = context.isError;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";

      if (expanded) {
        const c = new Container();
        for (const ln of text.split("\n")) {
          c.addChild(new Text(isError ? theme.fg("error", ln) : ln, 0, 0));
        }
        return c;
      }
      // Collapsed: width-aware single-line summary — truncated with "…" when it overflows
      // the viewport, instead of a fixed 100-char hard cut that still wraps on narrow terminals.
      const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
      const styled =
        `${icon} ${isError ? theme.fg("error", firstLine) : theme.fg("dim", firstLine)}`;
      return {
        render: (width: number) => [truncateToWidth(styled, width, "…", true)],
        invalidate: () => {},
      } satisfies Component;
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const mesh = getMeshAPI();
      const resolved = await mesh.resolvePeer({ at: params.name });

      if (!resolved) {
        throw new Error(
          `No online peer named "${params.name}". Call mesh_list to see who's online.`,
        );
      }
      if (Array.isArray(resolved)) {
        throw new Error(
          `Name "${params.name}" is ambiguous (${resolved.length} peers). Target by a different name.`,
        );
      }

      const peer = resolved as PeerInfo;
      const self = mesh.getSelfInfo();
      const conn = await mesh.connect(peer);
      try {
        await conn.request(MESSAGE_TYPE, { from: self.name, text: params.message });
        return {
          content: [
            { type: "text", text: params.message },
          ],
          details: { to: peer.name },
        };
      } catch (err) {
        throw new Error(
          `send_to ${peer.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        conn.close();
      }
    },
  });
}
