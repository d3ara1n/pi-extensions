/**
 * pi-peek-agent — Extension entry point.
 *
 * Cross-instance peek: UDS mesh + peer discovery + the `peek` LLM tool + a
 * statusbar widget. Consumes @d3ara1n/pi-peek's LOCAL investigate() to answer
 * remote asks (the server side runs here; only instances with this package
 * installed are discoverable and can serve asks).
 */

import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPeekAPI } from "@d3ara1n/pi-peek";
import { initPeekAgentAPI, tryGetPeekAgentAPI } from "./api.ts";
import { startPeekServer, type PeekServer } from "./ipc.ts";
import { writeSelfMarker, removeSelfMarker, resolveRegistryDir, cleanupGhostMarkers } from "./discovery.ts";
import { loadAgentConfig } from "./config.ts";
import { registerPeekTools } from "./tool.ts";
import { defaultSockDir, DEFAULT_AGENT_CONFIG } from "./types.ts";

export { getPeekAgentAPI } from "./api.ts";
export type { PeekAgentAPI, PeerInfo, ResolvePeerOptions, AskPeerOptions, AgentConfig } from "./types.ts";

// Short, memorable names. Single-word so they collide rarely and read cleanly.
// Adjective + noun combos (~500 distinct names) to keep collisions rare
// across reloads. Short enough to stay readable in the statusbar widget.
const ADJECTIVES = [
	"Swift", "Calm", "Bold", "Quiet", "Bright", "Lone", "Keen", "Merry",
	"Brisk", "Steady", "Frost", "Sunny", "Dark", "Wild", "Wise", "Vivid",
	"Amber", "Jade", "Onyx", "Coral",
];
const NOUNS = [
	"Fox", "Badger", "Hare", "Otter", "Falcon", "Heron", "Lynx", "Magpie",
	"Newt", "Owl", "Pika", "Raven", "Stoat", "Wren", "Robin", "Finch",
	"Pine", "Birch", "Cedar", "Maple", "Elm", "Ash", "Reed", "Fern",
];

function randomName(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] ?? "Peek";
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)] ?? "";
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

/** macOS limits UDS paths to ~104 chars; keep it short. */
function makeSockPath(sessionId: string): string {
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

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = crypto.randomUUID();
		const sockPath = makeSockPath(sessionId);
		const name = process.env["PI_PEEK_NAME"] || randomName();
		const cwd = ctx.cwd;
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
		const now = new Date().toISOString();

		const config = loadAgentConfig(cwd);
		const registryDir = resolveRegistryDir(config.registryDir);

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
		server = startPeekServer(sockPath, () => api.getSelfInfo(), {
			async onAsk(data, emitters) {
				const peekApi = getPeekAPI();
				const { answer } = await peekApi.investigate(data.question ?? "", {
					onToken: emitters.token,
					onStage: emitters.stage,
				});
				return { answer };
			},
		});

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
				removeSelfMarker(api.getSelfInfo().sessionId, resolveRegistryDir());
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
	});

	registerPeekTools(pi);
}
