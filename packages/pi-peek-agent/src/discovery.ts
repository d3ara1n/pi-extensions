/**
 * Discovery — lightweight PID-file registry + liveness probing.
 *
 * Each instance writes a tiny marker JSON (sessionId → {pid, sockPath, …}) to
 * a shared registry dir. Discovery = readdir + kill(pid,0) probe. Crashed peers
 * leave a marker that's pruned on the next read (O(1) per file, no data dirs).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { PeerInfo } from "./types.ts";
import { defaultRegistryDir } from "./types.ts";

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
 * Authoritative on Windows (where the pid probe is broken) and equally valid
 * on POSIX. Connect success ⇒ a server is listening at sockPath ⇒ the owning
 * process is alive. Connect failure/timeout ⇒ dead; caller should prune.
 * No data is exchanged — connect then immediately destroy.
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
 *   - POSIX: isPidAlive (kill(pid,0)) — synchronous, O(1), authoritative.
 *   - Windows: probeSocketAlive — kill(pid,0) is broken under Bun here.
 *
 * Dead peers have their marker file unlinked and are dropped from the result.
 * Probes run in parallel, so total latency ≈ a single probe's timeout.
 */
export async function pruneDeadPeers(peers: PeerInfo[], registryDir: string): Promise<PeerInfo[]> {
	const isWindows = process.platform === "win32";
	const probed = await Promise.all(
		peers.map(async (p) => {
			const alive = isWindows ? await probeSocketAlive(p.sockPath) : isPidAlive(p.pid);
			if (!alive) {
				try {
					fs.unlinkSync(markerPath(registryDir, p.sessionId));
				} catch {
					// ignore — marker may already be gone
				}
			}
			return alive ? p : null;
		}),
	);
	return probed.filter((p): p is PeerInfo => p !== null);
}

/** Resolve the registry directory (honors config override). */
export function resolveRegistryDir(override?: string): string {
	return override ?? defaultRegistryDir();
}

/** Write (or refresh) this instance's marker. */
export function writeSelfMarker(info: PeerInfo, registryDir: string): void {
	try {
		fs.mkdirSync(registryDir, { recursive: true });
		const file = markerPath(registryDir, info.sessionId);
		fs.writeFileSync(file, JSON.stringify(info, null, 2));
	} catch {
		// registry write failure is non-fatal (peek degrades to local-only)
	}
}

/** Remove this instance's marker (best-effort, called on shutdown). */
export function removeSelfMarker(sessionId: string, registryDir: string): void {
	try {
		fs.unlinkSync(markerPath(registryDir, sessionId));
	} catch {
		// ignore
	}
}

/**
 * Read all live peer markers, excluding self. Prunes markers whose pid is dead.
 * Does NOT socket-probe (that's deferred to connect time) — this is the fast
 * path for the statusbar count + the look-out panel.
 */
export function listPeersFromRegistry(
	registryDir: string,
	selfSessionId: string,
	_staleMs: number,
): PeerInfo[] {
	let files: string[];
	try {
		files = fs.readdirSync(registryDir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}

	const peers: PeerInfo[] = [];
	for (const f of files) {
		let info: PeerInfo;
		try {
			info = JSON.parse(fs.readFileSync(path.join(registryDir, f), "utf8")) as PeerInfo;
		} catch {
			continue;
		}
		if (!info || info.sessionId === selfSessionId) continue;

		// Liveness pruning is deferred to pruneDeadPeers() — that's where the
		// POSIX/Windows dispatch lives (Windows can't trust kill(pid,0)).
		peers.push(info);
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
		if (info.pid === pid && info.sessionId !== keepSessionId) {
			try {
				fs.unlinkSync(path.join(registryDir, f));
			} catch {
				// ignore
			}
		}
	}
}

function markerPath(registryDir: string, sessionId: string): string {
	return path.join(registryDir, `${sessionId}.json`);
}
