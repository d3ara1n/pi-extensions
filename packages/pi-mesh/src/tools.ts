/**
 * Mesh LLM tools — make pi-mesh self-sufficient.
 *
 * With mesh alone (no peek-agent, no chat-room), an agent can discover who else
 * is online, read a peer's self-declared role, and declare its own role. These
 * three tools are the "navigation + self-introduction" surface of the mesh;
 * contacting a peer (peek, message, …) is a consumer plugin's job.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { tryGetMeshAPI } from "./api.ts";
import type { MeshGetProfileDetails, MeshListDetails, PeerInfo } from "./types.ts";

// Theme type derived from ToolDefinition (the render types themselves are internal).
type RenderResultFn = NonNullable<ToolDefinition["renderResult"]>;
type RenderTheme = Parameters<RenderResultFn>[2];

/** Parse mesh_list output back into peer names for the collapsed summary. */
function parsePeerNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-\s+(\S+)/);
    if (m) names.push(m[1]!);
  }
  return names;
}

/**
 * One peer in the mesh-wide "peer entry" visual language, shared by mesh_list
 * and mesh_get_profile so a peer looks identical in both tools. Identity on
 * line 1 (name accent → role text → branch/model dim), context on line 2
 * (cwd/description muted); ambiguous peers get a sessionId targeting hint.
 */
function renderPeerEntry(p: PeerInfo, theme: RenderTheme): Text[] {
  // Line 1: identity — name is the scan target, role the selection cue.
  let line1 = theme.fg("accent", p.name);
  if (p.profile?.role) line1 += ` ${theme.fg("text", `[${p.profile.role}]`)}`;
  if (p.gitBranch) line1 += ` ${theme.fg("dim", `(${p.gitBranch})`)}`;
  if (p.ambiguous) line1 += ` ${theme.fg("warning", "⚠ ambiguous name")}`;
  line1 += ` ${theme.fg("dim", `· ${p.model}`)}`;
  // Line 2: context — long secondary text.
  let line2 = `    ${theme.fg("muted", p.cwd)}`;
  if (p.profile?.description) line2 += theme.fg("muted", ` — ${p.profile.description}`);
  const lines = [new Text(`- ${line1}`, 0, 0), new Text(line2, 0, 0)];
  if (p.ambiguous) {
    lines.push(
      new Text(`    ${theme.fg("warning", `sessionId: ${p.sessionId} (use this to target)`)}`, 0, 0),
    );
  }
  return lines;
}

/**
 * The peer "name card" on a single line, shared by mesh_get_profile and
 * mesh_set_profile collapsed: name (accent) → (model) (dim) → [role] (text) →
 * `: description` (muted, the weakest dim). The (model) parenthetical is
 * always-present info, so the card never degrades to a bare name (which would
 * just duplicate the call cell's target). Absent fields simply don't render.
 */
function nameCard(peer: PeerInfo, theme: RenderTheme): string {
  let s = theme.fg("accent", peer.name);
  s += ` ${theme.fg("dim", `(${peer.model})`)}`;
  if (peer.profile?.role) s += ` ${theme.fg("text", `[${peer.profile.role}]`)}`;
  if (peer.profile?.description) s += theme.fg("muted", `: ${peer.profile.description}`);
  return s;
}

/**
 * Shared result view for mesh_get_profile and mesh_set_profile — identical in
 * both tools so a profile reads the same whether fetched or just stored.
 * Collapsed = the name card on one line; expanded = the shared peer entry
 * (adds branch/cwd, description untruncated).
 */
const renderProfileResult: RenderResultFn = (result, { expanded }, theme, context) => {
  const isError = context.isError;
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  const peer = (result.details as MeshGetProfileDetails | undefined)?.peer;

  if (expanded) {
    const c = new Container();
    if (!peer) {
      // No structured peer (error result) — dump text lines as-is.
      for (const ln of text.split("\n")) c.addChild(new Text(ln, 0, 0));
      return c;
    }
    for (const t of renderPeerEntry(peer, theme)) c.addChild(t);
    return c;
  }
  let styled = `${icon} `;
  if (peer) {
    styled += nameCard(peer, theme);
  } else {
    const firstLine = text.split("\n")[0] ?? "";
    styled += isError ? theme.fg("error", firstLine) : theme.fg("dim", firstLine);
  }
  return {
    render: (width: number) => [truncateToWidth(styled, width, "…", true)],
    invalidate: () => {},
  } satisfies Component;
};

export function registerMeshTools(pi: ExtensionAPI): void {
  // ── mesh_list — discover online peers ──────────────────────────────────
  pi.registerTool({
    name: "mesh_list",
    label: "List mesh peers",
    description:
      "List other pi instances currently online on the agent mesh, with each peer's name, working directory (cwd), model, git branch, and self-declared role/description (if any). Same-project peers (same cwd) are listed first — the cwd tells you whether a peer shares your codebase.",
    promptSnippet: "Discover other pi agents on the mesh",
    promptGuidelines: [
      "Use mesh_list to see which other agents are online and their self-declared roles before deciding who to contact.",
    ],
    parameters: Type.Object({}),

    // Call cell: tool name (the summary appears in the result cell).
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("mesh_list")), 0, 0);
    },

    // Result cell: NO tool name (call already shows it). Collapsed = width-aware
    // name summary; expanded = the shared peer entry per peer (see
    // {@link renderPeerEntry}), with ambiguity warnings in `warning` so they
    // can't be missed.
    renderResult(result, { expanded }, theme, context) {
      const isError = context.isError;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";

      if (expanded) {
        const peers = (result.details as MeshListDetails | undefined)?.peers;
        if (!peers || peers.length === 0) {
          // No structured peers (error result, empty mesh) — dump text lines as-is.
          const c = new Container();
          for (const ln of text.split("\n")) c.addChild(new Text(ln, 0, 0));
          return c;
        }
        const c = new Container();
        c.addChild(new Text(theme.fg("text", `Online peers (${peers.length}):`), 0, 0));
        for (const p of peers) {
          for (const t of renderPeerEntry(p, theme)) c.addChild(t);
        }
        return c;
      }
      const names = parsePeerNames(text);
      const styled =
        names.length === 0
          ? `${icon} ${text.split("\n")[0] ?? ""}`
          : `${icon} ${theme.fg(
              "dim",
              names.length <= 5
                ? names.join(", ")
                : `${names.slice(0, 5).join(", ")} +${names.length - 5} more`,
            )}`;
      return {
        render: (width: number) => [truncateToWidth(styled, width, "…", true)],
        invalidate: () => {},
      } satisfies Component;
    },

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const api = tryGetMeshAPI();
      if (!api) throw new Error("mesh not initialized");
      const peers = await api.listPeers();
      if (peers.length === 0) {
        return {
          content: [
            { type: "text", text: "No other pi instances online on the mesh right now." },
          ],
          details: { peers: [] } satisfies MeshListDetails,
        };
      }
      const lines = peers.map((p) => {
        const role = p.profile?.role ? ` [${p.profile.role}]` : "";
        const branch = p.gitBranch ? ` (${p.gitBranch})` : "";
        const ambig = p.ambiguous ? " ⚠ ambiguous name" : "";
        const desc = p.profile?.description ? ` — ${p.profile.description}` : "";
        const sid = p.ambiguous ? `\n    sessionId: ${p.sessionId} (use this to target)` : "";
        // Two lines per peer: identity on line 1, cwd (long) on line 2.
        return `- ${p.name}${role}${branch}${ambig} · ${p.model}\n    ${p.cwd}${desc}${sid}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `Online peers (${peers.length}):\n${lines.join("\n")}`,
          },
        ],
        details: { peers } satisfies MeshListDetails,
      };
    },
  });

  // ── mesh_get_profile — read a peer's (or own) role/description ─────────
  pi.registerTool({
    name: "mesh_get_profile",
    label: "Get peer profile",
    description:
      "Read a peer's self-declared profile (role + description) and basic identity (name, model, cwd). Omit `name` to read your own profile.",
    promptGuidelines: [
      "Use mesh_get_profile to learn what a peer specializes in before contacting them.",
    ],
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description:
            "Name of the peer to look up (as shown by mesh_list). Omit to read your own profile.",
        }),
      ),
    }),

    // Call cell: tool name + target. A named peer is the emphasized act (accent
    // arrow); "→ self" is non-emphasized context (dim).
    renderCall(args, theme) {
      const target = args.name
        ? theme.fg("accent", ` → ${args.name}`)
        : theme.fg("dim", " → self");
      return new Text(theme.fg("toolTitle", theme.bold("mesh_get_profile")) + target, 0, 0);
    },

    // Result cell: shared with mesh_set_profile — the name card collapsed,
    // the peer entry expanded (see {@link renderProfileResult}).
    renderResult: renderProfileResult,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const api = tryGetMeshAPI();
      if (!api) throw new Error("mesh not initialized");

      let target;
      if (!params.name) {
        target = api.getSelfInfo();
      } else {
        const resolved = await api.resolvePeer({ at: params.name });
        if (!resolved) {
          throw new Error(`No online peer named "${params.name}".`);
        }
        if (Array.isArray(resolved)) {
          throw new Error(
            `Name "${params.name}" is ambiguous (${resolved.length} peers). Target by a different name or session id.`,
          );
        }
        target = resolved;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                name: target.name,
                role: target.profile?.role ?? null,
                description: target.profile?.description ?? null,
                model: target.model,
                cwd: target.cwd,
                gitBranch: target.gitBranch ?? null,
              },
              null,
              2,
            ),
          },
        ],
        details: { peer: target } satisfies MeshGetProfileDetails,
      };
    },
  });

  // ── mesh_set_profile — declare / update own role ───────────────────────
  pi.registerTool({
    name: "mesh_set_profile",
    label: "Set own profile",
    description:
      "Declare or update THIS instance's role and description on the mesh — the 'name card' other agents see via mesh_list / mesh_get_profile. Pass an empty string to clear a field. This is how you self-introduce: e.g. role='security lead', description='auth/crypto/injection audits'.",
    promptGuidelines: [
      "Use mesh_set_profile to announce your role so other agents know when to consult you; keep role short and description specific.",
    ],
    parameters: Type.Object({
      role: Type.Optional(
        Type.String({ description: "Short role/title, e.g. 'security lead', 'frontend designer'." }),
      ),
      description: Type.Optional(
        Type.String({
          description: "Specialties / when-to-consult detail. Empty string clears it.",
        }),
      ),
    }),

    // Call cell: tool name + the incoming change — first non-empty value in
    // accent; all-empty means clearing (dim, non-emphasized).
    renderCall(args, theme) {
      const change = [args.role, args.description].find((v) => v);
      const hasAny = args.role !== undefined || args.description !== undefined;
      const suffix = !hasAny
        ? theme.fg("dim", " …")
        : change
          ? theme.fg("accent", ` → ${change}`)
          : theme.fg("dim", " → (clear)");
      return new Text(
        theme.fg("toolTitle", theme.bold("mesh_set_profile")) + suffix,
        0,
        0,
      );
    },

    // Result cell: identical to mesh_get_profile's — a just-stored profile
    // reads the same as a fetched one (see {@link renderProfileResult}).
    renderResult: renderProfileResult,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const api = tryGetMeshAPI();
      if (!api) throw new Error("mesh not initialized");
      if (params.role === undefined && params.description === undefined) {
        throw new Error("Provide at least one of `role` or `description`.");
      }
      api.setProfile({ role: params.role, description: params.description });
      const profile = api.getProfile();
      const summary = `role=${profile?.role ?? "(none)"} description=${profile?.description ?? "(none)"}`;
      return {
        content: [{ type: "text", text: `Profile updated — ${summary}` }],
        details: { peer: api.getSelfInfo() } satisfies MeshGetProfileDetails,
      };
    },
  });
}
