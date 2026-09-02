/**
 * Offline regression tests for the mesh tools' TUI renderers.
 * Run: node --test packages/pi-mesh/src/tools.render.test.ts
 *
 * Captures the ToolDefinitions registered by registerMeshTools via a stub pi,
 * then exercises renderCall/renderResult with a pass-through theme (no ANSI
 * codes), so assertions read the plain text the user would see.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerMeshTools } from "./tools.ts";
import type { MeshGetProfileDetails, MeshListDetails, PeerInfo } from "./types.ts";

// Pass-through theme: fg/bold return text unchanged, so assertions see exactly
// what the user sees, minus ANSI colors.
const stubTheme = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as any;

// Capture registered tool definitions via a stub ExtensionAPI.
const defs: Record<string, any> = {};
registerMeshTools({ registerTool: (d: any) => void (defs[d.name] = d) } as any);

const peer: PeerInfo = {
  sessionId: "s-1",
  pid: 1,
  sockPath: "/tmp/s-1.sock",
  name: "Fox",
  cwd: "/Users/x/Projects/app",
  gitBranch: "main",
  model: "anthropic/claude-sonnet-4",
  since: "2026-01-01T00:00:00.000Z",
  lastSeen: "2026-01-01T00:00:00.000Z",
  profile: { role: "security lead", description: "auth/crypto/injection audits" },
};

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

// Collapsed lines via the width-aware one-line component (trimEnd: pad=true).
function renderCollapsed(tool: string, result: any, isError = false): string {
  const comp = defs[tool].renderResult(result, { expanded: false }, stubTheme, { isError });
  return comp.render(200).join("\n").trimEnd();
}

function renderExpanded(tool: string, result: any, isError = false): string {
  const comp = defs[tool].renderResult(result, { expanded: true }, stubTheme, { isError });
  return comp.render(200).join("\n");
}

function renderCall(tool: string, args: any): string {
  return defs[tool].renderCall(args, stubTheme).render(200).join("\n").trimEnd();
}

// ── mesh_get_profile ────────────────────────────────────────────────────────

test("mesh_get_profile renderCall shows the target peer in accent, self as dim → self", () => {
  assert.match(renderCall("mesh_get_profile", { name: "Fox" }), /mesh_get_profile → Fox/);
  assert.match(renderCall("mesh_get_profile", {}), /mesh_get_profile → self$/);
});

test("mesh_get_profile collapsed renders the whole name card on one line", () => {
  const line = renderCollapsed(
    "mesh_get_profile",
    textResult("{}", { peer } satisfies MeshGetProfileDetails),
  );
  assert.match(
    line,
    /^✓ Fox \(anthropic\/claude-sonnet-4\) \[security lead\]: auth\/crypto\/injection audits$/,
  );
});

test("mesh_get_profile collapsed degrades to name (model) without profile fields", () => {
  const bare = { ...peer, profile: undefined };
  const line = renderCollapsed(
    "mesh_get_profile",
    textResult("{}", { peer: bare } satisfies MeshGetProfileDetails),
  );
  assert.match(line, /^✓ Fox \(anthropic\/claude-sonnet-4\)$/);
});

test("mesh_get_profile collapsed colon-connects description when role is absent", () => {
  const descOnly = { ...peer, profile: { description: peer.profile!.description } };
  const line = renderCollapsed(
    "mesh_get_profile",
    textResult("{}", { peer: descOnly } satisfies MeshGetProfileDetails),
  );
  assert.match(line, /^✓ Fox \(anthropic\/claude-sonnet-4\): auth\/crypto\/injection audits$/);
});

test("mesh_get_profile expanded renders the shared peer entry with model/branch/cwd", () => {
  const out = renderExpanded(
    "mesh_get_profile",
    textResult("{}", { peer } satisfies MeshGetProfileDetails),
  );
  assert.match(out, /- Fox \[security lead\] \(main\) · anthropic\/claude-sonnet-4/);
  assert.match(out, /\/Users\/x\/Projects\/app — auth\/crypto\/injection audits/);
});

test("mesh_get_profile error result shows the first error line", () => {
  const line = renderCollapsed(
    "mesh_get_profile",
    textResult('No online peer named "Ghost".\nmore context', {}),
    true,
  );
  assert.match(line, /^✗ No online peer named "Ghost"\.$/);
});

// ── mesh_set_profile ────────────────────────────────────────────────────────

test("mesh_set_profile renderCall headlines the first non-empty change; all-empty is a dim clear", () => {
  assert.match(renderCall("mesh_set_profile", { role: "reviewer" }), /→ reviewer/);
  assert.match(renderCall("mesh_set_profile", { description: "docs" }), /→ docs/);
  assert.match(renderCall("mesh_set_profile", { role: "" }), /\(clear\)/);
});

test("mesh_set_profile result renders identically to mesh_get_profile in both modes", () => {
  const result = textResult("Profile updated — role=security lead description=auth/crypto", {
    peer,
  } satisfies MeshGetProfileDetails);
  // Collapsed: same name card as get, no "updated" verb.
  const collapsed = renderCollapsed("mesh_set_profile", result);
  assert.match(
    collapsed,
    /^✓ Fox \(anthropic\/claude-sonnet-4\) \[security lead\]: auth\/crypto\/injection audits$/,
  );
  assert.equal(collapsed, renderCollapsed("mesh_get_profile", result));
  // Expanded: same peer entry as get.
  assert.equal(renderExpanded("mesh_set_profile", result), renderExpanded("mesh_get_profile", result));
});

test("mesh_set_profile error result falls back to the text line", () => {
  const line = renderCollapsed(
    "mesh_set_profile",
    textResult("Provide at least one of `role` or `description`.", {}),
    true,
  );
  assert.match(line, /^✗ Provide at least one/);
});

// ── mesh_list (shared peer entry regression) ────────────────────────────────

test("mesh_list expanded renders two lines per peer plus sessionId hint when ambiguous", () => {
  const owl: PeerInfo = { ...peer, sessionId: "s-2", name: "Owl", ambiguous: true };
  const out = renderExpanded(
    "mesh_list",
    textResult("", { peers: [peer, owl] } satisfies MeshListDetails),
  );
  assert.match(out, /Online peers \(2\):/);
  assert.match(out, /- Fox \[security lead\] \(main\) · anthropic\/claude-sonnet-4/);
  assert.match(out, /- Owl .*⚠ ambiguous name/);
  assert.match(out, /sessionId: s-2 \(use this to target\)/);
});
