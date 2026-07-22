/**
 * PeekAgentAPI singleton — cross-instance capability.
 *
 * State stored on globalThis (key __piPeekAgent). Consumes @d3ara1n/pi-peek's
 * PeekAPI for the local investigate() that answers remote asks (the server
 * side) and for the tracker snapshot that ships in our PeerInfo.
 */

import { getPeekAPI } from "@d3ara1n/pi-peek";
import { connectPeer } from "./ipc.ts";
import * as discovery from "./discovery.ts";
import type {
  AgentConfig,
  AskPeerOptions,
  PeerInfo,
  PeekAgentAPI,
  ResolvePeerOptions,
} from "./types.ts";
import { DEFAULT_AGENT_CONFIG, PEEK_AGENT_GLOBAL_KEY } from "./types.ts";

export interface PeekAgentDeps {
  /** This instance's base identity (sessionId/pid/sockPath/name/cwd/model/since). */
  self: PeerInfo;
  /** Resolved config (already merged with defaults). */
  config: AgentConfig;
  /** Registry directory for PID-file markers. */
  registryDir: string;
}

export function initPeekAgentAPI(deps: PeekAgentDeps): PeekAgentAPI {
  const cfg = { ...DEFAULT_AGENT_CONFIG, ...deps.config };
  const state = {
    // Clone so model updates don't mutate the caller's object.
    self: { ...deps.self } as PeerInfo,
    registryDir: deps.registryDir,
  };

  const api: PeekAgentAPI = {
    updateModel(modelId: string): void {
      state.self.model = modelId;
    },

    setName(name: string): void {
      state.self.name = name || state.self.name;
    },

    getSelfInfo(): PeerInfo {
      // Fresh tracker snapshot on every read (status changes continuously).
      let status;
      try {
        status = getPeekAPI().getMainAgentStatus();
      } catch {
        status = undefined;
      }
      return {
        ...state.self,
        lastSeen: new Date().toISOString(),
        status,
      };
    },

    async listPeers(): Promise<PeerInfo[]> {
      const candidates = discovery.listPeersFromRegistry(
        state.registryDir,
        state.self.sessionId,
      );
      const peers = await discovery.pruneDeadPeers(candidates);
      discovery.flagAmbiguous(peers);
      return discovery.sortByProject(peers, state.self.cwd);
    },

    async resolvePeer(opts: ResolvePeerOptions = {}): Promise<PeerInfo | PeerInfo[] | undefined> {
      const peers = await api.listPeers();
      if (opts.sessionId) {
        return peers.find((p) => p.sessionId === opts.sessionId);
      }
      if (opts.at) {
        const named = peers.filter((p) => p.name === opts.at);
        if (named.length === 0) return undefined;
        if (named.length === 1) return named[0];
        return named; // ambiguous
      }
      // Auto: pick another peer in the same project.
      const sameProject = peers.filter(
        (p) => p.cwd === state.self.cwd && p.sessionId !== state.self.sessionId,
      );
      return sameProject[0];
    },

    async askPeer(peer: PeerInfo, question: string, opts: AskPeerOptions = {}): Promise<string> {
      opts.onStage?.("connecting");
      const conn = await connectPeer(peer.sockPath);
      try {
        return await conn.ask(question, {
          ...opts,
          timeoutMs: opts.timeoutMs ?? cfg.askTimeoutMs,
        });
      } finally {
        conn.close();
      }
    },

    async countPeers(): Promise<number> {
      const peers = await api.listPeers();
      return peers.length;
    },
  };

  (globalThis as any)[PEEK_AGENT_GLOBAL_KEY] = api;
  return api;
}

/** Get the initialized PeekAgentAPI. Throws if not initialized. */
export function getPeekAgentAPI(): PeekAgentAPI {
  const api = (globalThis as any)[PEEK_AGENT_GLOBAL_KEY] as PeekAgentAPI | undefined;
  if (!api) {
    throw new Error(
      "PeekAgentAPI not initialized. Ensure @d3ara1n/pi-peek-agent extension is loaded and session_start has fired.",
    );
  }
  return api;
}

/** Non-throwing getter. */
export function tryGetPeekAgentAPI(): PeekAgentAPI | undefined {
  return (globalThis as any)[PEEK_AGENT_GLOBAL_KEY] as PeekAgentAPI | undefined;
}
