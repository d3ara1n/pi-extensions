/**
 * pi-peek-agent — Extension entry point.
 *
 * Cross-instance peek: UDS mesh + peer discovery + the `peek` LLM tool + a
 * statusbar widget. Consumes @d3ara1n/pi-peek's LOCAL investigate() to answer
 * remote asks (the server side runs here; only instances with this package
 * installed are discoverable and can serve asks).
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPeekAPI } from "@d3ara1n/pi-peek";
import { initPeekAgentAPI, tryGetPeekAgentAPI } from "./api.ts";
import { startPeekServer, type PeekServer } from "./ipc.ts";
import {
  writeSelfMarker,
  removeSelfMarker,
  resolveRegistryDir,
  cleanupGhostMarkers,
} from "./discovery.ts";
import { loadAgentConfig } from "./config.ts";
import { registerPeekTools } from "./tool.ts";
import { defaultSockDir, DEFAULT_AGENT_CONFIG } from "./types.ts";

export { getPeekAgentAPI } from "./api.ts";
export type {
  PeekAgentAPI,
  PeerInfo,
  ResolvePeerOptions,
  AskPeerOptions,
  AgentConfig,
} from "./types.ts";

// Short, memorable names. Single-word so they collide rarely and read cleanly.
// Deterministically indexed by a hash of the session id (see deriveName), so
// the same session always gets the same name. ~3600 distinct combos:
// birthday-paradox collision only beyond ~70 sessions.
const ADJECTIVES = [
  "Swift",
  "Calm",
  "Bold",
  "Quiet",
  "Bright",
  "Lone",
  "Keen",
  "Merry",
  "Brisk",
  "Steady",
  "Frost",
  "Sunny",
  "Dark",
  "Wild",
  "Wise",
  "Vivid",
  "Amber",
  "Jade",
  "Onyx",
  "Coral",
  "Azure",
  "Ruby",
  "Indigo",
  "Olive",
  "Crisp",
  "Warm",
  "Cool",
  "Sharp",
  "Soft",
  "Deep",
  "High",
  "Still",
  "Lunar",
  "Solar",
  "Cosmic",
  "Misty",
  "Clear",
  "Rapid",
  "Slow",
  "Gold",
  "Silver",
  "Bronze",
  "Iron",
  "Steel",
  "Glass",
  "Stone",
  "Mossy",
  "Sandy",
  "Stormy",
  "Fair",
  "Pale",
  "Rich",
  "Pure",
  "Vast",
  "Dry",
  "Wet",
  "Grand",
  "Prime",
  "Noble",
  "Mellow",
];
const NOUNS = [
  "Fox",
  "Badger",
  "Hare",
  "Otter",
  "Falcon",
  "Heron",
  "Lynx",
  "Magpie",
  "Newt",
  "Owl",
  "Pika",
  "Raven",
  "Stoat",
  "Wren",
  "Robin",
  "Finch",
  "Pine",
  "Birch",
  "Cedar",
  "Maple",
  "Elm",
  "Ash",
  "Reed",
  "Fern",
  "Wolf",
  "Bear",
  "Hawk",
  "Doe",
  "Seal",
  "Crane",
  "Moth",
  "Bee",
  "Oak",
  "Willow",
  "Aspen",
  "Spruce",
  "Laurel",
  "Iris",
  "Lotus",
  "Flax",
  "Tide",
  "Gale",
  "Meadow",
  "Grove",
  "Crag",
  "Marsh",
  "Ridge",
  "Dune",
  "Creek",
  "Pond",
  "River",
  "Cliff",
  "Peak",
  "Vale",
  "Glen",
  "Brook",
  "Orchid",
  "Clover",
  "Sage",
  "Juniper",
];

/**
 * Derive a stable, memorable name from a session id.
 *
 * The name is a PURE FUNCTION of the session id (hash → pool index), so the
 * same session always gets the same name — across /reload, across restarts,
 * across machines. No persistence needed: re-deriving is cheaper and can't
 * drift. PI_PEEK_NAME still wins if set.
 */
function deriveName(sessionId: string): string {
  // FNV-1a over the sessionId → two independent 16-bit indices.
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    const c = sessionId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + 0x9e3779b9), 0x01000193) >>> 0;
  }
  const adj = ADJECTIVES[h1 % ADJECTIVES.length] ?? "Peek";
  const noun = NOUNS[h2 % NOUNS.length] ?? "";
  return noun ? `${adj}${noun}` : "Peek";
}

function getGitBranch(cwd: string): string | undefined {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000,
    });
    const b = out.trim();
    return b || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the IPC endpoint path for this session.
 *
 * On Windows we use a named pipe (`\\.\pipe\pi-peek-<id>`) — Node/Bun's
 * `node:net` transparently uses named pipes when the path is in the
 * `\\.\pipe\` / `\\?\pipe\` namespace, and Windows removes the pipe
 * automatically when the owning process exits (no unlink needed).
 *
 * On POSIX we use a Unix domain socket file under the temp dir. macOS limits
 * UDS paths to ~104 chars (sun_path), so we fall back to /tmp if too long.
 */
function makeSockPath(sessionId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-peek-${sessionId}`;
  }
  const candidate = `${defaultSockDir()}/pi-peek-${sessionId}.sock`;
  if (candidate.length <= 100) return candidate;
  return `/tmp/pi-peek-${sessionId}.sock`;
}

/** Refresh the statusbar widget: "peek Fox (3)". */
function refreshWidget(ctx: ExtensionContext, name: string, count: number): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  if (!theme) return;
  const label = theme.fg("dim", "peek");
  const who = theme.fg("accent", name);
  const n = theme.fg(count > 0 ? "success" : "dim", `(${count})`);
  ctx.ui.setStatus("peek-agent", `${label} ${who} ${n}`);
}

export default function registerPeekAgentExtension(pi: ExtensionAPI): void {
  let server: PeekServer | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let latestCtx: ExtensionContext | null = null;
  let activeRegistryDir: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    // Identity follows the SESSION, not the process or a random roll:
    // sessionId + name + sockPath are all derived from the real session id,
    // so /reload (same session) keeps the exact same identity, while resume /
    // fork / new-session get a fresh one. The name is a deterministic hash of
    // the id (no persistence, can't drift); PI_PEEK_NAME overrides if set.
    const sessionId = ctx.sessionManager.getSessionId();
    const sockPath = makeSockPath(sessionId);
    const name = process.env["PI_PEEK_NAME"] || deriveName(sessionId);
    const cwd = ctx.cwd;
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
    const now = new Date().toISOString();

    const config = loadAgentConfig(cwd);
    const registryDir = resolveRegistryDir(config.registryDir);
    activeRegistryDir = registryDir;

    const api = initPeekAgentAPI({
      self: {
        sessionId,
        pid: process.pid,
        sockPath,
        name,
        cwd,
        gitBranch: getGitBranch(cwd),
        model,
        since: now,
        lastSeen: now,
      },
      config,
      registryDir,
    });

    // Verify the local consult capability is available (pi-peek must be loaded).
    try {
      getPeekAPI();
    } catch {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-peek-agent requires @d3ara1n/pi-peek to answer remote asks. Load pi-peek alongside it.",
          "warning",
        );
      }
    }

    // Wipe markers left by a previous session of this same process (/reload).
    cleanupGhostMarkers(registryDir, process.pid, sessionId);

    // Serve remote asks: serialize our conversation + investigate via utility model.
    // Never touches our main session — getPeekAPI().investigate() is read-after-burn.
    const serverResult = await startPeekServer(sockPath, () => api.getSelfInfo(), {
      async onAsk(data, emitters) {
        const peekApi = getPeekAPI();
        const { answer } = await peekApi.investigate(data.question ?? "", {
          onToken: emitters.token,
          onStage: emitters.stage,
        });
        return { answer };
      },
    });

    if (serverResult.error || !serverResult.server) {
      const message = `peek-agent failed to start IPC server at ${sockPath}: ${serverResult.error?.message ?? "unknown error"}`;
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else console.error(message);
      latestCtx = ctx;
      refreshWidget(ctx, name, 0);
      return;
    }
    server = serverResult.server;

    // Seed our registry marker + heartbeat (also refreshes the widget count).
    writeSelfMarker(api.getSelfInfo(), registryDir);
    latestCtx = ctx;
    refreshWidget(ctx, name, 0);

    const hb = config.heartbeatMs ?? DEFAULT_AGENT_CONFIG.heartbeatMs;
    heartbeat = setInterval(async () => {
      writeSelfMarker(api.getSelfInfo(), registryDir);
      if (latestCtx) {
        try {
          const count = await api.countPeers();
          refreshWidget(latestCtx, name, count);
        } catch {
          // ignore — widget keeps last value
        }
      }
    }, hb);

    // Initial peer count (async, non-blocking).
    void api.countPeers().then((c) => {
      if (latestCtx) refreshWidget(latestCtx, name, c);
    });

    if (ctx.hasUI) {
      ctx.ui.notify(`peek-agent ready as ${name}`, "info");
    }
  });

  pi.on("model_select", (event) => {
    const api = tryGetPeekAgentAPI();
    const m = event.model;
    if (api && m) api.updateModel(`${m.provider}/${m.id}`);
  });

  pi.on("session_shutdown", () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    const api = tryGetPeekAgentAPI();
    if (api) {
      try {
        removeSelfMarker(api.getSelfInfo().sessionId, activeRegistryDir ?? resolveRegistryDir());
      } catch {
        // ignore
      }
    }
    if (server) {
      server.close();
      server = null;
    }
    if (latestCtx?.hasUI) {
      latestCtx.ui.setStatus("peek-agent", undefined);
    }
    activeRegistryDir = null;
  });

  registerPeekTools(pi);
}
