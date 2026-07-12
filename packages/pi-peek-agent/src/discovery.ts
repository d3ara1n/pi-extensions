/**
 * Discovery — lightweight PID-file registry + liveness probing.
 *
 * Each instance writes a tiny marker JSON (sessionId → {pid, sockPath, …}) to
 * a shared registry dir. Discovery validates marker identity, then probes the
 * owning process and socket. Crashed peers leave a marker that's pruned on the
 * next read (O(1) per file, no data dirs).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { PeerInfo } from "./types.ts";
import { defaultRegistryDir } from "./types.ts";

interface RegistryPeer extends PeerInfo {
  /** Path obtained from the registry enumeration and validated against sessionId. */
  markerFile: string;
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId);
}

/**
 * Returns true if a process with the given pid is alive (POSIX kill(pid,0)).
 *
 * POSIX-accurate and O(1). On Windows this is NOT reliable: under Bun,
 * process.kill(pid, 0) can throw ESRCH for arbitrary (non-child) live pids
 * (libuv's win uv__kill has no signal-0 case). Windows callers must use
 * probeSocketAlive() instead — see pruneDeadPeers() for the dispatch.
 */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it — treat as alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cross-platform liveness probe via a one-shot socket connect.
 *
 * Connect success ⇒ a server is listening at sockPath ⇒ the owning process is
 * alive. Connect failure/timeout ⇒ dead; caller should prune. No data is
 * exchanged — connect then immediately destroy.
 */
export async function probeSocketAlive(sockPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect(sockPath);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

/**
 * Probe every candidate peer for liveness and prune dead markers.
 *
 * Platform dispatch:
 *   - POSIX: isPidAlive (kill(pid,0)) followed by probeSocketAlive. The
 *     socket check prevents a reused PID from keeping a stale marker alive.
 *   - Windows: probeSocketAlive — kill(pid,0) is broken under Bun here.
 *
 * Dead peers have their marker file unlinked and are dropped from the result.
 * Probes run in parallel, so total latency ≈ a single probe's timeout.
 */
export async function pruneDeadPeers(peers: RegistryPeer[]): Promise<PeerInfo[]> {
  const isWindows = process.platform === "win32";
  const probed = await Promise.all(
    peers.map(async (p) => {
      const alive = isWindows
        ? await probeSocketAlive(p.sockPath)
        : isPidAlive(p.pid) && (await probeSocketAlive(p.sockPath));
      if (!alive) {
        try {
          fs.unlinkSync(p.markerFile);
        } catch {
          // ignore — marker may already be gone
        }
      }
      return alive ? p : null;
    }),
  );
  return probed.filter((p): p is RegistryPeer => p !== null);
}

/** Resolve the registry directory (honors config override and leading `~`). */
export function resolveRegistryDir(override?: string): string {
  if (!override) return defaultRegistryDir();
  if (override === "~") return os.homedir();
  if (override.startsWith(`~${path.sep}`) || override.startsWith("~/")) {
    return path.join(os.homedir(), override.slice(2));
  }
  return override;
}

/** Write (or refresh) this instance's marker. */
export function writeSelfMarker(info: PeerInfo, registryDir: string): void {
  try {
    const file = markerPath(registryDir, info.sessionId);
    if (!file) return;
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(info, null, 2));
  } catch {
    // registry write failure is non-fatal (peek degrades to local-only)
  }
}

/** Remove this instance's marker (best-effort, called on shutdown). */
export function removeSelfMarker(sessionId: string, registryDir: string): void {
  try {
    const file = markerPath(registryDir, sessionId);
    if (file) fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

/** Read validated peer markers, excluding self. */
export function listPeersFromRegistry(
  registryDir: string,
  selfSessionId: string,
): RegistryPeer[] {
  let files: string[];
  try {
    files = fs.readdirSync(registryDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const peers: RegistryPeer[] = [];
  for (const f of files) {
    let info: PeerInfo;
    try {
      info = JSON.parse(fs.readFileSync(path.join(registryDir, f), "utf8")) as PeerInfo;
    } catch {
      continue;
    }
    if (!info || !isSafeSessionId(info.sessionId) || f !== `${info.sessionId}.json`) continue;
    if (info.sessionId === selfSessionId) continue;
    peers.push({ ...info, markerFile: path.join(registryDir, f) });
  }
  return peers;
}

/** Group peers: same-project (cwd match) first, then others. */
export function sortByProject(peers: PeerInfo[], selfCwd: string): PeerInfo[] {
  return [...peers].sort((a, b) => {
    const aSame = a.cwd === selfCwd ? 0 : 1;
    const bSame = b.cwd === selfCwd ? 0 : 1;
    return aSame - bSame;
  });
}

/** Mark peers sharing a name (collision detection for resolvePeer). */
export function flagAmbiguous(peers: PeerInfo[]): PeerInfo[] {
  const byName = new Map<string, number>();
  for (const p of peers) {
    byName.set(p.name, (byName.get(p.name) ?? 0) + 1);
  }
  for (const p of peers) {
    p.ambiguous = (byName.get(p.name) ?? 0) > 1;
  }
  return peers;
}

/** Remove markers that belong to our own pid but a previous session id
 *  (left over from /reload in the same process). Called once on startup. */
export function cleanupGhostMarkers(registryDir: string, pid: number, keepSessionId: string): void {
  let files: string[];
  try {
    files = fs.readdirSync(registryDir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    let info: PeerInfo;
    try {
      info = JSON.parse(fs.readFileSync(path.join(registryDir, f), "utf8")) as PeerInfo;
    } catch {
      continue;
    }
    if (
      info.pid === pid &&
      isSafeSessionId(info.sessionId) &&
      f === `${info.sessionId}.json` &&
      info.sessionId !== keepSessionId
    ) {
      try {
        fs.unlinkSync(path.join(registryDir, f));
      } catch {
        // ignore
      }
    }
  }
}

function markerPath(registryDir: string, sessionId: string): string | undefined {
  if (!isSafeSessionId(sessionId)) return undefined;
  return path.join(registryDir, `${sessionId}.json`);
}
