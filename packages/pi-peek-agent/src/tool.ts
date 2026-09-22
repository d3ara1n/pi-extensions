/**
 * pi-peek-agent tool — exposes cross-instance peek to the main agent (LLM).
 *
 * One tool: peek({ question, at?, sessionId? }) investigates a peer's session record.
 * `question` is required (enforced by schema). Peer discovery moved to
 * @d3ara1n/pi-mesh (its `mesh_list` tool) — resolvePeer/connect come from there.
 *
 * Rendering follows the built-in tool convention: the call cell already shows
 * the tool name, so renderResult MUST NOT repeat it. Collapsed shows the
 * supplied summary (or the first report line); expanded shows the original
 * question from ToolRenderContext.args above the complete report.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getMeshAPI } from "@d3ara1n/pi-mesh";
import type { PeerInfo } from "@d3ara1n/pi-mesh";
import { loadPeekConfig } from "./config.ts";
import { INVESTIGATE_TYPE } from "./types.ts";
import type { InvestigateResponseData } from "./types.ts";

/** Build a tool result (AgentToolResult requires a `details` field). */
function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined as unknown,
  };
}

export function registerPeekTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "peek",
    label: "Peek at another instance",
    description:
      "Peek at another pi instance — observe its session without disturbing it. " +
      "Read-only: a helper model investigates the peer's existing session record and reports findings; the peer's agent never sees the question and cannot act on it — not a communication channel. " +
      "Use mesh_list first to discover names. " +
      "Best for focused summaries, explanations, or details in the peer's saved tool results that its replies did not mention. " +
      "Strictly observation, not consultation: it reports only what the record contains — do not use it for design input, decisions, or advice. " +
      "Each call uses a fresh snapshot; include enough context for follow-up questions.",
    promptSnippet: "Observe another pi instance's session without disturbing it",

    parameters: Type.Object({
      question: Type.String({
        description:
          "What you want to find out from the peer's existing session record (e.g. 'What is it working on right now?'). The peer's agent never sees this question.",
      }),
      includeThinking: Type.Optional(Type.Boolean({
        description: "Include readable thinking saved in the session. Default false; unavailable or redacted thinking cannot be recovered.",
      })),
      at: Type.Optional(
        Type.String({
          description:
            "Target instance name (e.g. 'Fox'). Omit to auto-pick the other same-project instance.",
        }),
      ),
      sessionId: Type.Optional(
        Type.String({
          description: "Pin a specific instance by sessionId (use when names collide).",
        }),
      ),
    }),

    // Call cell: tool name + target. The report appears in the result cell.
    renderCall(args, theme) {
      const target = (args as any).at ? ` → ${(args as any).at}` : " → (auto)";
      return new Text(theme.fg("toolTitle", theme.bold("peek")) + theme.fg("accent", target), 0, 0);
    },

    // Result cell: NO tool name. Collapsed = summary or first report line; expanded = question + full report.
    renderResult(result, { expanded }, theme, context) {
      const isError = context.isError;
      const isPartial = context.isPartial;
      const icon = isPartial
        ? theme.fg("warning", "⏳")
        : isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n\n") || "(no output)";

      if (expanded) {
        const c = new Container();
        // The question asked (shared across call/result renders for this tool
        // call via ToolRenderContext.args). Surfaced above the report so the
        // full Q&A exchange is visible when expanded.
        const question =
          typeof context.args?.question === "string" ? context.args.question : "";
        if (question.trim()) {
          c.addChild(
            new Text(
              theme.fg("accent", theme.bold("Q")) +
                theme.fg("dim", "  ") +
                theme.fg("muted", question),
              0,
              0,
            ),
          );
          c.addChild(new Text("", 0, 0));
        }
        for (const ln of text.split("\n")) {
          c.addChild(new Text(isError ? theme.fg("error", ln) : ln, 0, 0));
        }
        return c;
      }
      // Only the display line is normalized; the full summary stays in details.
      const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
      const summary = !isPartial && !isError
        ? (result.details as InvestigateResponseData | undefined)?.summary?.replace(/\r\n|\r|\n/g, " ")
        : undefined;
      const styled =
        `${icon} ${isError ? theme.fg("error", firstLine) : theme.fg("dim", summary || firstLine)}`;
      return {
        render: (width: number) => [truncateToWidth(styled, width, "…", true)],
        invalidate: () => {},
      } satisfies Component;
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const mesh = getMeshAPI();
      const resolved = await mesh.resolvePeer({
        at: params.at,
        sessionId: params.sessionId,
      });

      signal?.throwIfAborted();
      if (!resolved) {
        throw new Error(params.at
          ? `No online peer named '${params.at}'. Call mesh_list to see who's online.`
          : "No other pi instance available to peek.");
      }

      // Name collision → return candidates so the LLM disambiguates with sessionId.
      if (Array.isArray(resolved)) {
        const cands = resolved
          .map(
            (p) =>
              `- ${p.name} · sessionId=${p.sessionId} · ${p.gitBranch ?? "(no branch)"} · ${p.cwd}`,
          )
          .join("\n");
        return textResult(
          `Multiple instances named '${params.at}'. Specify sessionId to pin one:\n${cands}`,
        );
      }

      const peer = resolved as PeerInfo;
      const cfg = loadPeekConfig(ctx?.cwd);
      try {
        const conn = await mesh.connect(peer);
        try {
          signal?.throwIfAborted();
          const result = await conn.request(
            INVESTIGATE_TYPE,
            { question: params.question, ...(params.includeThinking === true ? { includeThinking: true } : {}) },
            {
              signal, timeoutMs: cfg.investigateTimeoutMs,
              onEmit: (type, data) => {
                if (type === "stage" && data && typeof data === "object" && "stage" in data && typeof data.stage === "string") {
                  onUpdate?.(textResult(`Peek ${peer.name}: ${data.stage}`));
                }
              },
            },
          );
          const response = result as InvestigateResponseData | undefined;
          const resultText = textResult(response?.report ?? "");
          if (response?.stopReason === "length") {
            resultText.content.push({ type: "text", text: "Output limit reached; the report is incomplete." });
          }
          return {
            ...resultText,
            details: response ? { summary: response.summary, snapshotAt: response.snapshotAt, stopReason: response.stopReason, usage: response.usage } : undefined,
          };
        } finally {
          conn.close();
        }
      } catch (err) {
        throw new Error(`peek ${peer.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
