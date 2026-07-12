/**
 * pi-access-denied — sandbox write/edit/bash to the project directory.
 *
 * Gates built-in `write`, `edit`, and `bash` tools so they cannot reach paths
 * outside an allowlist (cwd + configured allowedPaths) without authorization,
 * and hard-blocks any path listed in `deniedPaths` (optionally with a reason
 * that is surfaced back to the agent as a redirect).
 *
 * Three modes (switchable at runtime via `/access-denied`):
 *   - prompt: ask the user; choices are allow / always-allow / deny / always-deny
 *   - deny:   block any out-of-bounds access outright
 *   - allow:  passthrough (effectively disable the gate)
 *
 * All access decisions flow through a single PathManager (path-manager.ts)
 * using longest-prefix-match across three rule layers (builtin / config /
 * session). "Always" decisions from the panel and config `deniedPaths` are
 * remembered per session — restarting pi (or `/reload`, `/new`, `/resume`)
 * forgets the SESSION ones; config rules reload from settings.
 *
 * The agent never learns WHICH layer denied it: both config and session deny
 * reasons surface uniformly as a "user note", so the agent only ever sees
 * "the user declined this" — the software speaks with the user's voice.
 */

import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.ts";
import { PathManager } from "./path-manager.ts";
import { extractBashTargets, resolveTarget, toPosix } from "./paths.ts";
import { DEFAULT_CONFIG, type AccessMode, type AuthResult } from "./types.ts";
import { AuthPanel } from "./auth-panel.ts";

const GLOBAL_KEY = "__piAccessDenied";
const STATUS_KEY = "access-denied";

interface SessionState {
  mode: AccessMode;
  config: typeof DEFAULT_CONFIG;
  /** The single path-access authority. Rebuilt on session_start from config. */
  pm: PathManager;
  alive: boolean;
}

function getState(): SessionState {
  const g = globalThis as Record<symbol | string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      mode: DEFAULT_CONFIG.mode,
      config: DEFAULT_CONFIG,
      pm: new PathManager(process.cwd(), DEFAULT_CONFIG.allowedPaths, DEFAULT_CONFIG.deniedPaths),
      alive: false,
    } satisfies SessionState;
  }
  return g[GLOBAL_KEY] as SessionState;
}

// ── UI helpers ────────────────────────────────────────────────────────────

// Nerd Font: nf-fa-key / nf-fa-lock / nf-fa-unlock
const MODE_ICON: Record<AccessMode, string> = { prompt: "\uf084", deny: "\uf023", allow: "\uf13c" };

function updateStatus(ctx: ExtensionContext) {
  const state = getState();
  if (!state.alive) return;
  const icon = MODE_ICON[state.mode];
  // Only color the mode word after the colon; the icon + label stay default.
  const modeWord =
    state.mode === "deny"
      ? ctx.ui.theme.fg("error", state.mode)
      : state.mode === "allow"
        ? ctx.ui.theme.fg("success", state.mode)
        : state.mode;
  ctx.ui.setStatus(STATUS_KEY, `${icon} access:${modeWord}`);
}

function formatPaths(paths: string[]): string {
  return paths.map((p) => `  • ${p}`).join("\n");
}

/**
 * Uniform deny reason for any deny (config or session). The agent receives a
 * "user note" and cannot tell which layer produced it — the software speaks as
 * the user. An empty note yields the plain default message.
 */
function denyReason(note?: string): string {
  const trimmed = note?.trim();
  return trimmed
    ? `Blocked by access-denied (user note: "${trimmed}")`
    : "Blocked by access-denied";
}

/**
 * Show the authorization panel. Returns an {@link AuthResult}; when the user
 * dismisses the path list (Esc), `cancelled` is true.
 */
async function promptDecision(
  toolName: string,
  violations: string[],
  ctx: ExtensionContext,
): Promise<AuthResult> {
  const header = toolName === "bash" ? "bash command" : `${toolName}`;
  return ctx.ui.custom<AuthResult>(
    (tui, theme, _kb, done) => {
      return new AuthPanel(violations, header, tui, theme, { onResult: (r) => done(r) });
    },
    {
      // overlay:false renders the panel into pi's bottom editorContainer slot
      // (the same path ctx.ui.select()/input() take) instead of compositing a
      // screen overlay over everything. The chat transcript stays visible above
      // the panel and is scrollable via the terminal's native scrollback.
      // overlay:true would hide the transcript via ui.showOverlay(), making it
      // unscrollable — see pi-ask-user for the same design decision.
      overlay: false,
    },
  );
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const state = getState();
    state.config = loadConfig(ctx.cwd);
    state.mode = state.config.mode; // reset to configured mode each session
    state.pm = new PathManager(ctx.cwd, state.config.allowedPaths, state.config.deniedPaths);
    state.alive = true;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    const state = getState();
    state.alive = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    const state = getState();
    if (!state.alive) return; // not bound to a session yet

    const toolName = event.toolName;
    if (!state.config.tools.includes(toolName)) return;

    const pm = state.pm;
    const cwd = ctx.cwd;

    // 1. Extract the targets this call wants to reach.
    //    write/edit: the single `path` argument — exact.
    //    bash:       heuristic scan of the command string (escaping candidates only).
    let targets: string[];
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      targets = [resolveTarget(event.input.path, cwd)];
    } else if (isToolCallEventType("bash", event)) {
      targets = extractBashTargets(event.input.command, cwd);
    } else {
      return; // tool not understood here — nothing to gate
    }

    // 2. Classify every target through the single PathManager decision engine.
    //    decide() returns allow | deny | outside. A deny is an explicit rule
    //    (config deniedPaths or a remembered always-deny); outside means no
    //    allow rule covers it and it needs authorization.
    const denyNotes: string[] = [];
    const outside: string[] = [];
    for (const target of targets) {
      const d = pm.decide(target);
      if (d.kind === "deny") denyNotes.push(d.reason ?? "");
      else if (d.kind === "outside") outside.push(target);
    }

    // 3. Any explicit deny blocks immediately — deny is authoritative and
    //    needs no user interaction. The most informative note wins; the agent
    //    can't distinguish config-deny from session-deny (both = "user note").
    if (denyNotes.length) {
      const note = denyNotes.find((r) => r.trim()) ?? "";
      return { block: true, reason: denyReason(note) };
    }

    // 4. Nothing outside the rules → fully in-bounds, passthrough.
    if (outside.length === 0) return;

    // 5. mode logic applies only to uncovered ("outside") targets.
    if (state.mode === "allow") return; // gate disabled

    if (state.mode === "deny") {
      return {
        block: true,
        reason: `Blocked by access-denied (deny mode): ${formatPaths(outside)}`,
      };
    }

    // prompt mode — but no UI available (print/json mode): fail safe.
    if (!ctx.hasUI) {
      return { block: true, reason: `Blocked (no UI to authorize): ${formatPaths(outside)}` };
    }

    // 6. Prompt for the outside paths.
    const result = await promptDecision(toolName, outside, ctx);
    if (result.cancelled) {
      // dismissed — soft deny so the agent learns it was not authorized
      return { block: true, reason: "Authorization dismissed" };
    }

    // Persist every "always" choice before deciding this call. A deny still
    // blocks the whole call, but any simultaneous always-allow must remain
    // available to subsequent calls.
    const userNote = result.reason?.trim() ?? "";
    for (const [p, c] of result.choices) {
      if (c === "always-allow") pm.addSessionAllow(p);
      else if (c === "always-deny") pm.addSessionDeny(p, userNote);
    }

    // Any deny blocks the whole call. The stored deny reason is the user's RAW
    // note, re-wrapped on each cache hit so a misleading note can't pass as an
    // operation result (defense-in-depth alongside is_error: true).
    const hasDeny = [...result.choices.values()].some((c) => c === "deny" || c === "always-deny");
    if (hasDeny) {
      return { block: true, reason: denyReason(userNote) };
    }

    return; // all allow / always-allow → passthrough this call
  });

  // ── Commands ───────────────────────────────────────────────────────────

  // /access-denied prompt | deny | allow
  pi.registerCommand("access-denied", {
    description: "Set access-denied mode: prompt | deny | allow",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const opts = ["prompt", "deny", "allow"];
      const items = opts.map((o) => ({ value: o, label: o }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const state = getState();
      const arg = (args || "").trim().toLowerCase();

      if (arg === "prompt" || arg === "deny" || arg === "allow") {
        state.mode = arg;
        ctx.ui.notify(`access-denied → ${arg}`, "info");
        updateStatus(ctx);
        return;
      }

      ctx.ui.notify(
        "Usage: /access-denied prompt | deny | allow\n" +
          "Use /access-denied:status to view current rules.",
        "error",
      );
    },
  });

  // /access-denied:status
  pi.registerCommand("access-denied:status", {
    description: "Show current access-denied status and rules",
    handler: async (_args, ctx) => {
      const state = getState();
      const rules = state.pm.getRules();
      const cwdNorm = toPosix(resolveTarget(ctx.cwd, ctx.cwd));
      const allowConfig = rules.config.filter((r) => r.decision === "allow");
      const allowSession = rules.session.filter((r) => r.decision === "allow");
      const denyRules = [
        ...rules.config.filter((r) => r.decision === "deny"),
        ...rules.session.filter((r) => r.decision === "deny"),
      ];

      const lines: string[] = [];
      lines.push(`Mode: ${state.mode}   Tools: ${state.config.tools.join(", ")}`);
      lines.push("");
      lines.push("Allow rules (matched → passthrough):");
      if (rules.builtin.length) {
        lines.push(`  • ${rules.builtin.map((r) => r.path).join(", ")}   (builtin)`);
      }
      for (const r of allowConfig) {
        const tag = r.path === cwdNorm ? "(cwd)" : "(config)";
        lines.push(`  • ${r.path}   ${tag}`);
      }
      for (const r of allowSession) {
        lines.push(`  • ${r.path}   (session)`);
      }
      lines.push("");
      lines.push("Deny rules (matched → blocked):");
      if (denyRules.length === 0) {
        lines.push("  (none)");
      } else {
        for (const r of denyRules) {
          const src = r.source === "config" ? "(config)" : "(session)";
          const reason = r.reason ? `  — ${r.reason}` : "";
          lines.push(`  • ${r.path}   ${src}${reason}`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /access-denied:reset
  pi.registerCommand("access-denied:reset", {
    description: "Clear session allow/deny memory",
    handler: async (_args, ctx) => {
      const state = getState();
      state.pm.clearSession();
      ctx.ui.notify("Cleared session allow/deny memory", "info");
    },
  });
}
