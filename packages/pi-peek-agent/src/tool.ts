/** Cross-instance record retrieval over pi-mesh, with progress and Markdown rendering. */

import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { formatInvestigationStatus, PeekReportParser, summarizePeekReport } from "@d3ara1n/pi-peek";
import { getMeshAPI } from "@d3ara1n/pi-mesh";
import type { PeerInfo } from "@d3ara1n/pi-mesh";
import { loadPeekConfig } from "./config.ts";
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

/** Collapsed overview while running: "stage · chars" from the partial details. */
function partialStatus(details: unknown, fallback: string): string {
  const progress = details as InvestigateProgressData | undefined;
  if (!progress || typeof progress.stage !== "string" || typeof progress.chars !== "number")
    return fallback;
  return formatInvestigationStatus(progress.stage, progress.chars);
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
      "Retrieve and summarize records from another pi session. A helper reads a fresh snapshot; the target assistant is not contacted.",
    promptSnippet: "Retrieve records from another pi session",
    promptGuidelines: [
      "Use mesh_list to discover target names when needed.",
      "Use peek to gather recorded information; handle evaluation, recommendations and decisions yourself.",
    ],

    parameters: Type.Object({
      question: Type.String({
        description:
          "Information to find in the session. Include the context needed for follow-up requests.",
      }),
      includeThinking: Type.Optional(
        Type.Boolean({
          description:
            "Include readable thinking saved in the session. Default false; unavailable or redacted thinking cannot be recovered.",
        }),
      ),
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
      const progress = result.details as InvestigateProgressData | undefined;
      const awaitingReport =
        isPartial && progress?.stage && !["outputting", "done", "error"].includes(progress.stage);
      const text = awaitingReport
        ? ""
        : result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n\n") || (isPartial ? "" : "(no output)");

      if (expanded) {
        const c = new Container();
        // The question asked (ToolRenderContext.args) as a muted context line —
        // no Q/A markers; the report below is the content the user expanded for.
        const question = typeof context.args?.question === "string" ? context.args.question : "";
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
      const styled = `${icon} ${isError && !isPartial ? theme.fg("error", line) : theme.fg("muted", line)}`;
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
        throw new Error(
          params.at
            ? `No online peer named '${params.at}'. Call mesh_list to see who's online.`
            : "No other pi instance available to peek.",
        );
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

      // Current peers send parsed report bodies. The same parser supports legacy raw-token peers.
      let reportText = "";
      let nativeReportTokens = false;
      const appendReport = (delta: string) => {
        reportText += delta;
      };
      let legacyParser = new PeekReportParser(appendReport);
      const progress: InvestigateProgressData = { stage: "connecting", chars: 0 };
      const progressAbort = new AbortController();
      const requestSignal = signal
        ? AbortSignal.any([signal, progressAbort.signal])
        : progressAbort.signal;
      let lastPushAt = 0;
      let pendingPush: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const clearPush = () => {
        if (pendingPush) clearTimeout(pendingPush);
        pendingPush = undefined;
      };
      const pushProgress = () => {
        clearPush();
        if (finished || requestSignal.aborted) return;
        lastPushAt = Date.now();
        const visible = reportText;
        try {
          onUpdate?.({
            content: visible ? [{ type: "text" as const, text: visible }] : [],
            details: { ...progress, chars: visible.length },
          });
        } catch (error) {
          // Timer-driven updates must reject the request, not throw an uncaught asynchronous error.
          progressAbort.abort(error);
        }
      };
      const schedulePush = () => {
        const wait = PROGRESS_THROTTLE_MS - (Date.now() - lastPushAt);
        if (wait <= 0) pushProgress();
        else if (!pendingPush) pendingPush = setTimeout(pushProgress, wait);
      };
      pushProgress();

      try {
        requestSignal.throwIfAborted();
        const conn = await mesh.connect(peer);
        try {
          requestSignal.throwIfAborted();
          const result = await conn.request(
            INVESTIGATE_TYPE,
            {
              question: params.question,
              ...(params.includeThinking === true ? { includeThinking: true } : {}),
            },
            {
              signal: requestSignal,
              timeoutMs: cfg.investigateTimeoutMs,
              onEmit: (type, data) => {
                if (finished || requestSignal.aborted || !data || typeof data !== "object") return;
                if (type === "report_reset") {
                  reportText = "";
                  legacyParser = new PeekReportParser(appendReport);
                  progress.stage = "investigating";
                  progress.phase = "investigation";
                  pushProgress();
                  return;
                }
                if (
                  (type === "stage" || type === "progress") &&
                  "stage" in data &&
                  typeof data.stage === "string"
                ) {
                  const previous = progress.stage;
                  // A report never switches back to investigation while its text is visible.
                  if (
                    reportText.length === 0 ||
                    previous !== "outputting" ||
                    ["outputting", "done", "error"].includes(data.stage)
                  )
                    progress.stage = data.stage;
                  const incoming = data as Partial<InvestigateProgressData>;
                  if (incoming.phase === "investigation" || incoming.phase === "report")
                    progress.phase = incoming.phase;
                  if (typeof incoming.model === "string") progress.model = incoming.model;
                  for (const key of [
                    "round",
                    "maxRounds",
                    "request",
                    "toolCalls",
                    "elapsedMs",
                  ] as const) {
                    const value = incoming[key];
                    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
                      progress[key] = value;
                  }
                  if (previous !== progress.stage) pushProgress();
                  else schedulePush();
                } else if (
                  type === "token" &&
                  "delta" in data &&
                  typeof data.delta === "string" &&
                  data.delta
                ) {
                  if ("format" in data && data.format === "report") {
                    nativeReportTokens = true;
                    appendReport(data.delta);
                  } else legacyParser.push(data.delta);
                  const changed = progress.stage !== "outputting";
                  progress.stage = "outputting";
                  progress.phase = reportText.length > 0 ? "report" : "investigation";
                  if (changed) pushProgress();
                  else schedulePush();
                }
              },
            },
          );
          requestSignal.throwIfAborted();
          const response = result as InvestigateResponseData | undefined;
          if (!response?.report) throw new Error("Empty investigation response.");
          let summary = response.summary;
          let reportMode = response.reportMode;
          if (reportMode || nativeReportTokens) {
            reportText = response.report;
          } else {
            // Older peers may return a raw envelope with preamble; decode it with the shared rules.
            const parser = new PeekReportParser();
            parser.push(response.report);
            const parsed = parser.finish(response.report);
            reportText = parsed.report;
            summary ||= parsed.summary;
            reportMode = parsed.reportMode;
          }
          summary ||= summarizePeekReport(reportText);
          progress.phase = "report";
          progress.stage = "done";
          pushProgress();
          requestSignal.throwIfAborted();
          const resultText = textResult(reportText);
          if (response?.stopReason === "length") {
            resultText.content.push({
              type: "text",
              text: "Output limit reached; the report is incomplete.",
            });
          }
          return {
            ...resultText,
            details: response
              ? {
                  summary,
                  ...(reportMode ? { reportMode } : {}),
                  snapshotAt: response.snapshotAt,
                  stopReason: response.stopReason,
                  usage: response.usage,
                  ...(response.metrics ? { metrics: response.metrics } : {}),
                }
              : undefined,
          };
        } finally {
          conn.close();
        }
      } catch (error) {
        progress.stage = "error";
        pushProgress();
        const partial = reportText;
        throw new Error(
          `peek ${peer.name} failed: ${error instanceof Error ? error.message : String(error)}${partial ? `\n\nIncomplete report:\n${partial}` : ""}`,
        );
      } finally {
        finished = true;
        clearPush();
      }
    },
  });
}
