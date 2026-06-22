/**
 * Discovery — lightweight PID-file registry + liveness probing.
 *
 * Each instance writes a tiny marker JSON (sessionId → {pid, sockPath, …}) to
 * a shared registry dir. Discovery = readdir + kill(pid,0) probe. Crashed peers
 * leave a marker that's pruned on the next read (O(1) per file, no data dirs).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PeerInfo } from "./types.ts";
import { defaultRegistryDir } from "./types.ts";

/** Returns true if a process with the given pid is alive (POSIX kill(pid,0)). */
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

		// Authoritative check: pid alive?
		if (!isPidAlive(info.pid)) {
			try {
				fs.unlinkSync(path.join(registryDir, f));
			} catch {
				// ignore
			}
			continue;
		}

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
