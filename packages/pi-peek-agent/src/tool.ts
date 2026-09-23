/**
 * pi-peek-agent tool — exposes cross-instance peek to the main agent (LLM).
 *
 * One tool: peek({ question, at?, sessionId? }) investigates a peer's session record.
 * `question` is required (enforced by schema). Peer discovery moved to
 * @d3ara1n/pi-mesh (its `mesh_list` tool) — resolvePeer/connect come from there.
 *
 * Rendering follows the built-in tool convention: the call cell already shows
 * the tool name, so renderResult MUST NOT repeat it. Collapsed shows the live
 * "stage · chars" overview while running and the peer-supplied summary (or
 * first report line) once done; expanded shows the question as a muted context
 * line above the report — rendered as Markdown (same as subagent output and
 * the /peek overlay), streamed live while the investigation runs, with no
 * overview row.
 */

import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getMeshAPI } from "@d3ara1n/pi-mesh";
import type { PeerInfo } from "@d3ara1n/pi-mesh";
import { loadPeekConfig } from "./config.ts";
import { EnvelopeFilter } from "./envelope-filter.ts";
import { INVESTIGATE_TYPE } from "./types.ts";
import type { InvestigateProgressData, InvestigateResponseData } from "./types.ts";

/** @internal Throttle for live-progress pushes; token deltas arrive per token and are bursty. */
export const PROGRESS_THROTTLE_MS = 250;

/** Build a tool result (AgentToolResult requires a `details` field). */
function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined as unknown,
  };
}

/** Compact count for the live status line, e.g. 943 → "943", 12345 → "12.3k". */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Collapsed overview while running: "stage · chars" from the partial details. */
function partialStatus(details: unknown, fallback: string): string {
  const progress = details as InvestigateProgressData | undefined;
  if (!progress || typeof progress.stage !== "string" || typeof progress.chars !== "number") return fallback;
  const chars = progress.chars > 0 ? ` · ${formatCount(progress.chars)} chars` : "";
  return `${progress.stage}${chars}`;
}

/** Collapsed summary once done: the peer-supplied summary, or the first report line. */
function finalSummary(details: unknown, firstLine: string): string {
  const summary = (details as InvestigateResponseData | undefined)?.summary;
  return summary?.replace(/\r\n|\r|\n/g, " ") || firstLine;
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

    // Result cell: NO tool name. Collapsed = live "stage · chars" overview
    // while running, summary (or first report line) once done; expanded = the
    // question as a muted context line above the report, streamed while running.
    renderResult(result, { expanded }, theme, context) {
      const isError = context.isError;
      const isPartial = context.isPartial;
      const icon = isPartial
        ? theme.fg("warning", "⏳")
        : isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n\n")
        || (isPartial ? "" : "(no output)");

      if (expanded) {
        const c = new Container();
        // The question asked (ToolRenderContext.args) as a muted context line —
        // no Q/A markers; the report below is the content the user expanded for.
        const question =
          typeof context.args?.question === "string" ? context.args.question : "";
        if (question.trim()) {
          // The separator "\n" is folded into the question line: Text("")
          // renders zero lines, so a separate empty child would show nothing.
          c.addChild(new Text(theme.fg("muted", question) + "\n", 0, 0));
        }
        if (text) {
          if (isError) {
            for (const ln of text.split("\n")) {
              c.addChild(new Text(theme.fg("error", ln), 0, 0));
            }
          } else {
            // Report bodies are Markdown — same presentation as subagent
            // output and the /peek overlay (headings, code, highlighting),
            // for both the streamed partial and the final result.
            c.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
          }
        } else {
          // Running with no visible text yet — a quiet placeholder beats an
          // empty hole (a finished empty result keeps "(no output)" above).
          c.addChild(new Text(theme.fg("dim", "…"), 0, 0));
        }
        return c;
      }

      // Collapsed: the overview lives in partial details while running and is
      // replaced by the summary (or first report line) when the result lands.
      const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
      const line = isPartial
        ? partialStatus(result.details, firstLine)
        : isError
          ? firstLine
          : finalSummary(result.details, firstLine);
      const styled = `${icon} ${isError && !isPartial ? theme.fg("error", line) : theme.fg("dim", line)}`;
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

      // Live progress: partial details drive the collapsed "stage · chars"
      // overview; partial content streams the report through the envelope
      // filter (summary swallowed, tags stripped, malformed → raw passthrough)
      // for the expanded view. Token deltas arrive per token and are bursty,
      // so pushes are throttled; stage changes always push immediately.
      const filter = new EnvelopeFilter();
      let stage = "connecting";
      let lastPushAt = 0;
      const pushProgress = () => {
        lastPushAt = Date.now();
        const visible = filter.displayText;
        onUpdate?.({
          content: visible ? [{ type: "text" as const, text: visible }] : [],
          details: { stage, chars: visible.length },
        });
      };
      pushProgress();

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
                if (data && typeof data === "object") {
                  if (type === "stage" && "stage" in data && typeof data.stage === "string") {
                    stage = data.stage;
                    pushProgress();
                  } else if (type === "token" && "delta" in data && typeof data.delta === "string") {
                    filter.push(data.delta);
                    if (Date.now() - lastPushAt >= PROGRESS_THROTTLE_MS) pushProgress();
                  }
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
