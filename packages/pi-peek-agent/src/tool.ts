/**
 * pi-peek-agent tools — exposes cross-instance peek to the main agent (LLM).
 *
 * Two tools (split so schema validation enforces required params at the
 * framework level — no hand-rolled "missing question" messages):
 *
 *   peek_list()                                 → list online peers
 *   peek({ question, at?, sessionId? })         → ask a peer (question required)
 *
 * Rendering follows the built-in tool convention: the call cell already shows
 * the tool name, so renderResult MUST NOT repeat it — it only renders the
 * result body (collapsed = tight summary, expanded = full).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { getPeekAgentAPI } from "./api.ts";
import type { PeerInfo } from "./types.ts";

/** Build a tool result (AgentToolResult requires a `details` field). */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined as unknown,
    isError,
  };
}

/** Compact "name, name, name +N more" summary of a peer list. */
function summarizePeers(peers: PeerInfo[], max = 5): string {
  if (peers.length === 0) return "no peers online";
  const shown = peers.slice(0, max);
  const names = shown.map((p) => (p.gitBranch ? `${p.name}:${p.gitBranch}` : p.name)).join(", ");
  const more = peers.length - shown.length;
  return more > 0 ? `${names} +${more} more` : names;
}

function fullPeerList(peers: PeerInfo[]): string {
  if (peers.length === 0) return "No peers online.";
  return peers
    .map((p) => {
      const branch = p.gitBranch ? ` (${p.gitBranch})` : "";
      const status = p.status?.activity ? ` · ${p.status.activity}` : "";
      const ambig = p.ambiguous ? " ⚠ duplicate name" : "";
      return `- ${p.name}${branch}${ambig}  [${p.cwd}]${status}`;
    })
    .join("\n");
}

export function registerPeekTools(pi: ExtensionAPI): void {
  // ── peek_list: list online peers ──────────────────────────────────────
  pi.registerTool({
    name: "peek_list",
    label: "List pi instances",
    description:
      "List other pi instances online (visible to cross-instance peek), grouped by project. " +
      "Use before peek() to discover names. Peers appear only if they have @d3ara1n/pi-peek-agent loaded.",
    promptSnippet: "List online pi instances visible to cross-instance peek",

    parameters: Type.Object({}),

    // Call cell: tool name + count hint (the summary appears in the result cell).
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("peek_list")), 0, 0);
    },

    // Result cell: NO tool name (call already shows it). Collapsed = name summary.
    renderResult(result, { expanded }, theme, context) {
      const isError = context.isError;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";

      if (expanded) {
        const c = new Container();
        for (const ln of text.split("\n")) c.addChild(new Text(ln, 0, 0));
        return c;
      }
      // Collapsed: parse the full list back into a peer-name summary.
      // (text is fullPeerList output; extract names from "- Name (branch) …" lines)
      const peers = parsePeerList(text);
      return new Text(`${icon} ${theme.fg("dim", summarizePeers(peers))}`, 0, 0);
    },

    async execute() {
      const api = getPeekAgentAPI();
      const peers = await api.listPeers();
      return textResult(
        `${peers.length} peer${peers.length === 1 ? "" : "s"} online\n` + fullPeerList(peers),
      );
    },
  });

  // ── peek: ask a peer a question (question is required, enforced by schema) ──
  pi.registerTool({
    name: "peek",
    label: "Peek at another instance",
    description:
      "Peek at another pi instance — ask it a question without disturbing its main conversation. " +
      "The peeked instance's main agent is completely unaffected; the answer comes from its side " +
      "utility model (read-after-burn). Use for cross-instance coordination: check progress, " +
      "confirm details, ask how something works. Use peek_list first to discover names.",
    promptSnippet: "Ask another pi instance a question without disturbing it (cross-instance peek)",

    parameters: Type.Object({
      question: Type.String({
        description: "The question to ask the other instance.",
      }),
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

    // Call cell: tool name + target. The answer appears in the result cell.
    renderCall(args, theme) {
      const target = (args as any).at ? ` → ${(args as any).at}` : " → (auto)";
      return new Text(theme.fg("toolTitle", theme.bold("peek")) + theme.fg("accent", target), 0, 0);
    },

    // Result cell: NO tool name. Collapsed = first line of the answer.
    renderResult(result, { expanded }, theme, context) {
      const isError = context.isError;
      const isPartial = context.isPartial;
      const icon = isPartial
        ? theme.fg("warning", "⏳")
        : isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";

      if (expanded) {
        const c = new Container();
        for (const ln of text.split("\n")) {
          c.addChild(new Text(isError ? theme.fg("error", ln) : ln, 0, 0));
        }
        return c;
      }
      // Collapsed: first non-empty line, truncated. No tool name prefix.
      const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
      const body = isError
        ? theme.fg("error", firstLine.slice(0, 100))
        : theme.fg("dim", firstLine.slice(0, 100));
      return new Text(`${icon} ${body}`, 0, 0);
    },

    async execute(_toolCallId, params, signal) {
      const api = getPeekAgentAPI();
      const resolved = await api.resolvePeer({
        at: params.at,
        sessionId: params.sessionId,
      });

      if (!resolved) {
        return textResult(
          params.at
            ? `No online peer named '${params.at}'. Call peek_list to see who's online.`
            : "No other pi instance available to peek.",
          true,
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
      try {
        const answer = await api.askPeer(peer, params.question, { signal });
        return textResult(answer);
      } catch (err) {
        return textResult(
          `peek ${peer.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  });
}

/** Parse fullPeerList() output back into names for the collapsed summary. */
function parsePeerList(text: string): PeerInfo[] {
  const peers: PeerInfo[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-\s+(\S+)(?:\s+\(([^)]+)\))?/);
    if (m) {
      peers.push({
        name: m[1]!,
        gitBranch: m[2],
      } as PeerInfo);
    }
  }
  return peers;
}
