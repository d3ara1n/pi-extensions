/**
 * pi-mesh — Extension entry point.
 *
 * Agent mesh for pi: peer discovery + cross-instance transport. This extension
 * owns the instance's mesh identity (stable name derived from the session id,
 * renameable), the PID-file registry marker, the UDS server, and a statusbar
 * widget. It also registers the mesh_list/mesh_get_profile/mesh_set_profile
 * tools so the mesh is self-sufficient: an agent can discover peers and
 * self-introduce a role with mesh alone.
 *
 * Identity follows the SESSION, not the process: sessionId + name + sockPath
 * are all derived from the real session id, so /reload (same session) keeps the
 * exact same identity, while resume/fork/new-session get a fresh one. Consumers
 * (pi-peek-agent, future chat-room) register request handlers via MeshAPI.serve().
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initMeshAPI, tryGetMeshAPI } from "./api.ts";
import { startMeshServer, type MeshServer } from "./ipc.ts";
import {
  cleanupGhostMarkers,
  removeSelfMarker,
  resolveRegistryDir,
  writeSelfMarker,
} from "./discovery.ts";
import { loadMeshConfig } from "./config.ts";
import { deriveName, getGitBranch, makeSockPath } from "./naming.ts";
import { registerMeshTools } from "./tools.ts";
import { DEFAULT_MESH_CONFIG, MESH_READY_EVENT } from "./types.ts";

export { getMeshAPI, tryGetMeshAPI } from "./api.ts";
export { MESH_READY_EVENT } from "./types.ts";
export type {
  EmitFn,
  MeshAPI,
  MeshConfig,
  MeshConnection,
  PeerInfo,
  PeerProfile,
  RequestOptions,
  ResolvePeerOptions,
  ServeHandler,
} from "./types.ts";

/** Refresh the statusbar widget: "mesh Fox (3)". */
function refreshWidget(ctx: ExtensionContext, name: string, count: number): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  if (!theme) return;
  const label = theme.fg("muted", "mesh");
  const who = theme.fg("accent", name);
  const n = theme.fg(count > 0 ? "success" : "dim", `(${count})`);
  ctx.ui.setStatus("mesh", `${label} ${who} ${n}`);
}

export default function registerMeshExtension(pi: ExtensionAPI): void {
  let server: MeshServer | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let latestCtx: ExtensionContext | null = null;
  let activeRegistryDir: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sockPath = makeSockPath(sessionId);
    const name = process.env["PI_MESH_NAME"] || deriveName(sessionId);
    const cwd = ctx.cwd;
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
    const now = new Date().toISOString();

    const config = loadMeshConfig(cwd);
    const registryDir = resolveRegistryDir(config.registryDir);
    activeRegistryDir = registryDir;

    const { api, route } = initMeshAPI({
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

    // Wipe markers left by a previous session of this same process (/reload).
    cleanupGhostMarkers(registryDir, process.pid, sessionId);

    // Serve incoming typed requests by routing to registered serve() handlers.
    const serverResult = await startMeshServer(sockPath, {
      async onRequest(type, data, emit) {
        return route(type, data, emit);
      },
    });

    if (serverResult.error || !serverResult.server) {
      const message = `mesh failed to start IPC server at ${sockPath}: ${serverResult.error?.message ?? "unknown error"}`;
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

    // Announce readiness so order-agnostic consumers (e.g. pi-peek-agent)
    // can register serve() handlers via pi.events regardless of load order.
    pi.events.emit(MESH_READY_EVENT, api);

    const hb = config.heartbeatMs ?? DEFAULT_MESH_CONFIG.heartbeatMs;
    heartbeat = setInterval(async () => {
      writeSelfMarker(api.getSelfInfo(), registryDir);
      if (latestCtx) {
        try {
          refreshWidget(latestCtx, name, await api.countPeers());
        } catch {
          // ignore — widget keeps last value
        }
      }
    }, hb);

    // Initial peer count (async, non-blocking).
    void api
      .countPeers()
      .then((c) => {
        if (latestCtx) refreshWidget(latestCtx, name, c);
      })
      .catch(() => {
        // ignore
      });

    if (ctx.hasUI) {
      ctx.ui.notify(`mesh ready as ${name}`, "info");
    }
  });

  pi.on("model_select", (event) => {
    const api = tryGetMeshAPI();
    const m = event.model;
    if (api && m) api.updateModel(`${m.provider}/${m.id}`);
  });

  pi.on("session_shutdown", () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    const api = tryGetMeshAPI();
    if (api) {
      try {
        removeSelfMarker(
          api.getSelfInfo().sessionId,
          activeRegistryDir ?? resolveRegistryDir(),
        );
      } catch {
        // ignore
      }
    }
    if (server) {
      server.close();
      server = null;
    }
    if (latestCtx?.hasUI) {
      latestCtx.ui.setStatus("mesh", undefined);
    }
    activeRegistryDir = null;
  });

  // ── /mesh:rename ── overrides the derived identity name ───────────────
  pi.registerCommand("mesh:rename", {
    description: "Rename this mesh instance (overrides the derived identity name)",
    handler: async (argsStr, ctx) => {
      const newName = (argsStr ?? "").trim();
      if (!newName) {
        ctx.ui.notify("Usage: /mesh:rename <new-name>", "warning");
        return;
      }
      const api = tryGetMeshAPI();
      if (!api) {
        ctx.ui.notify("mesh not initialized yet", "error");
        return;
      }
      api.setName(newName);
      const count = await api.countPeers();
      const theme = ctx.ui.theme;
      if (theme) {
        ctx.ui.setStatus(
          "mesh",
          `${theme.fg("muted", "mesh")} ${theme.fg("accent", newName)} ${theme.fg("success", `(${count})`)}`,
        );
      }
      ctx.ui.notify(`mesh renamed to ${newName}`, "info");
    },
  });

  // ── /mesh:status ── debug: show self info + peer list ──────────────────
  pi.registerCommand("mesh:status", {
    description: "Show mesh status: self info, registry dir, and online peers",
    handler: async (_argsStr, ctx) => {
      const api = tryGetMeshAPI();
      if (!api) {
        ctx.ui.notify("mesh not initialized yet", "error");
        return;
      }
      const self = api.getSelfInfo();
      const peers = await api.listPeers();
      const cfg = loadMeshConfig(ctx.cwd);

      const lines = [
        `mesh              ${self.name}`,
        `session id        ${self.sessionId}`,
        `pid               ${self.pid}`,
        `socket            ${self.sockPath}`,
        `model             ${self.model}`,
        `cwd               ${self.cwd}`,
        `git branch        ${self.gitBranch ?? "(none)"}`,
        `role              ${self.profile?.role ?? "(none)"}`,
        `description       ${self.profile?.description ?? "(none)"}`,
        `registry dir      ${resolveRegistryDir(cfg.registryDir)}`,
        ``,
        `peers             ${peers.length} online`,
      ];

      for (const p of peers) {
        const branch = p.gitBranch ? ` (${p.gitBranch})` : "";
        const role = p.profile?.role ? ` · ${p.profile.role}` : "";
        const ambig = p.ambiguous ? " ⚠" : "";
        const isSelf = p.sessionId === self.sessionId ? " ← self" : "";
        lines.push(`  ${p.name}${branch}${role}${ambig}${isSelf}`);
        lines.push(`    ${p.cwd}`);
        if (p.profile?.description) lines.push(`    ${p.profile.description}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  registerMeshTools(pi);
}
