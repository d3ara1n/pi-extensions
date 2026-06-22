/**
 * UDS transport — Unix domain socket server/client with JSON-per-line framing.
 *
 * Zero-dependency (node:net only). Clean teardown is kernel-managed: when a
 * process dies (any cause, incl. SIGKILL/crash), its fds close and the socket
 * stops accepting immediately. The only residue is the socket file path and a
 * registry marker JSON — both pruned by discovery on the next probe.
 *
 * Protocol: each message is one JSON line ("\n"-terminated). Three kinds:
 *   request  { kind:"request",  id, type:"ask"|"ping", data? }   client → server
 *   response { kind:"response", id, ok, data?, error? }          server → client
 *   emit     { kind:"emit",     type:"status"|"stage"|"token", data? }  server → client (no id)
 */

import * as net from "node:net";
import * as fs from "node:fs";
import type {
	AskPeerOptions,
	AskRequestData,
	AskResponseData,
	IpcMessage,
	PeerInfo,
} from "./types.ts";

// ─── shared line writer ──────────────────────────────────────────────────────

function writeMsg(socket: net.Socket, msg: IpcMessage): void {
	if (socket.writableEnded || socket.destroyed) return;
	try {
		socket.write(JSON.stringify(msg) + "\n");
	} catch {
		// socket gone — ignore
	}
}

// ─── server ──────────────────────────────────────────────────────────────────

export interface ServerEmitters {
	token: (delta: string) => void;
	stage: (stage: string) => void;
	status: () => void;
}

export interface PeekServerHandlers {
	onAsk(data: AskRequestData, emitters: ServerEmitters): Promise<AskResponseData>;
}

export interface PeekServer {
	close(): void;
}

/**
 * Start a UDS server at sockPath. On connection, reads JSON-per-line requests.
 * "ask" requests are handled by `handlers.onAsk`; the server streams emits
 * back during handling, then sends the final response.
 */
export function startPeekServer(
	sockPath: string,
	getSelfInfo: () => PeerInfo,
	handlers: PeekServerHandlers,
): PeekServer {
	// Remove a stale socket file from a crashed previous owner.
	try {
		fs.unlinkSync(sockPath);
	} catch {
		// didn't exist — fine
	}

	const server = net.createServer((socket) => {
		let buffer = "";

		const emitters: ServerEmitters = {
			token: (delta) => writeMsg(socket, { kind: "emit", type: "token", data: { delta } }),
			stage: (stage) => writeMsg(socket, { kind: "emit", type: "stage", data: { stage } }),
			status: () => writeMsg(socket, { kind: "emit", type: "status", data: getSelfInfo() }),
		};

		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (!line.trim()) continue;
				void handleServerLine(socket, line, handlers, emitters);
			}
		});
		socket.on("error", () => {
			// client disconnected abruptly — nothing to do
		});
	});

	server.listen(sockPath);
	server.on("error", () => {
		// surface nothing fatal; pi keeps running
	});

	return {
		close() {
			try {
				server.close();
			} catch {
				// ignore
			}
			try {
				fs.unlinkSync(sockPath);
			} catch {
				// ignore
			}
		},
	};
}

async function handleServerLine(
	socket: net.Socket,
	line: string,
	handlers: PeekServerHandlers,
	emitters: ServerEmitters,
): Promise<void> {
	let msg: IpcMessage;
	try {
		msg = JSON.parse(line) as IpcMessage;
	} catch {
		return;
	}
	if (msg.kind !== "request") return;

	if (msg.type === "ping") {
		writeMsg(socket, { kind: "response", id: msg.id, ok: true });
		return;
	}

	if (msg.type === "ask") {
		const data = (msg.data ?? {}) as AskRequestData;
		try {
			// Push current status first so the asker sees what we're doing right now.
			emitters.status();
			const result = await handlers.onAsk(data, emitters);
			writeMsg(socket, { kind: "response", id: msg.id, ok: true, data: result });
		} catch (err) {
			writeMsg(socket, {
				kind: "response",
				id: msg.id,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// ─── client ──────────────────────────────────────────────────────────────────

export interface PeerConnection {
	/** Send an ask; resolves with the full answer. Emits feed opts callbacks. */
	ask(question: string, opts: AskPeerOptions): Promise<string>;
	close(): void;
}

/** Connect to a peer's UDS. Rejects on connect failure/timeout. */
export function connectPeer(sockPath: string, connectTimeoutMs = 5000): Promise<PeerConnection> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(sockPath);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`connect timeout to ${sockPath}`));
		}, connectTimeoutMs);

		socket.on("connect", () => {
			clearTimeout(timer);
			resolve(makeConnection(socket));
		});
		socket.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function makeConnection(socket: net.Socket): PeerConnection {
	let buffer = "";
	let reqCounter = 0;
	const pending = new Map<string, { resolve: (data: AskResponseData) => void; reject: (e: Error) => void }>();
	// A connection handles one ask at a time (peek semantics). Emits route to the active sink.
	let activeSink: { onToken?: (d: string) => void; onStage?: (s: string) => void; onStatus?: (p: PeerInfo) => void } | null = null;

	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let idx: number;
		while ((idx = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let msg: IpcMessage;
			try {
				msg = JSON.parse(line) as IpcMessage;
			} catch {
				continue;
			}
			routeMessage(msg);
		}
	});

	socket.on("error", () => {
		// fail any in-flight ask
		for (const [, p] of pending) p.reject(new Error("connection closed"));
		pending.clear();
	});

	function routeMessage(msg: IpcMessage): void {
		if (msg.kind === "response") {
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.ok) {
				p.resolve((msg.data ?? { answer: "" }) as AskResponseData);
			} else {
				p.reject(new Error(msg.error ?? "peer error"));
			}
			return;
		}
		if (msg.kind === "emit" && activeSink) {
			const d = msg.data as any;
			if (msg.type === "token" && typeof d?.delta === "string") activeSink.onToken?.(d.delta);
			else if (msg.type === "stage" && typeof d?.stage === "string") activeSink.onStage?.(d.stage);
			else if (msg.type === "status" && d) activeSink.onStatus?.(d as PeerInfo);
		}
	}

	return {
		async ask(question, opts) {
			const id = `req-${++reqCounter}`;
			const result = new Promise<string>((resolve, reject) => {
				pending.set(id, { resolve: (data) => resolve(data.answer), reject });
			});
			const timeoutMs = opts.timeoutMs ?? 30_000;
			const timer = setTimeout(() => {
				const p = pending.get(id);
				if (p) {
					pending.delete(id);
					p.reject(new Error("ask timeout"));
				}
			}, timeoutMs);

			activeSink = {
				onToken: opts.onToken,
				onStage: opts.onStage,
				onStatus: opts.onStatus,
			};
			opts.onStage?.("sent");
			writeMsg(socket, { kind: "request", id, type: "ask", data: { question } });

			try {
				if (opts.signal) {
					opts.signal.addEventListener(
						"abort",
						() => {
							const p = pending.get(id);
							if (p) {
								pending.delete(id);
								p.reject(new Error("aborted"));
							}
						},
						{ once: true },
					);
				}
				return await result;
			} finally {
				clearTimeout(timer);
				activeSink = null;
			}
		},
		close() {
			try {
				socket.destroy();
			} catch {
				// ignore
			}
		},
	};
}
