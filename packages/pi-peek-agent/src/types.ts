/**
 * pi-peek-agent shared types.
 *
 * Cross-instance transport (UDS) + peer discovery + the LLM `peek` tool.
 * This is the only package that knows about sockets, registry markers, or
 * other pi instances. It consumes @d3ara1n/pi-peek's LOCAL investigate()
 * capability to answer remote asks.
 */

import type { MainAgentStatus } from "@d3ara1n/pi-peek";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
	/** Registry directory for PID-file markers. Default ~/.pi/peek/registry. */
	registryDir?: string;
	/** How often to refresh our own marker's lastSeen. Default 15s. */
	heartbeatMs?: number;
	/** A peer is considered stale if lastSeen is older than this. Default 45s. */
	staleMs?: number;
	/** askPeer synchronous wait timeout. Default 30s. */
	askTimeoutMs?: number;
}

export const DEFAULT_AGENT_CONFIG: Required<
	Pick<AgentConfig, "heartbeatMs" | "staleMs" | "askTimeoutMs">
> = {
	heartbeatMs: 15_000,
	staleMs: 45_000,
	askTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Peer discovery
// ---------------------------------------------------------------------------

export interface PeerInfo {
	/** Unique instance id (crypto.randomUUID()). */
	sessionId: string;
	/** OS pid — used for liveness probing (kill(pid, 0)). */
	pid: number;
	/** UDS path to connect to. */
	sockPath: string;
	/** Display name (PI_PEEK_NAME or random adjective+noun). */
	name: string;
	/** Working directory — used to group "same project" peers. */
	cwd: string;
	/** Git branch, if any (same-project disambiguation). */
	gitBranch?: string;
	/** Current main model id (provider/id). */
	model: string;
	/** When this peer's session started (ISO). */
	since: string;
	/** Last heartbeat (ISO). Socket probe is authoritative; this is auxiliary. */
	lastSeen: string;
	/** Live tracker snapshot, if available (from pi-peek). */
	status?: MainAgentStatus;
	/** True when multiple live peers share this name (name collision). */
	ambiguous?: boolean;
}

export interface ResolvePeerOptions {
	/** Target by name. Omit to auto-pick the other same-project peer. */
	at?: string;
	/** Target by exact sessionId (wins over `at` on collision). */
	sessionId?: string;
}

// ---------------------------------------------------------------------------
// askPeer() — cross-instance synchronous ask
// ---------------------------------------------------------------------------

export interface AskPeerOptions {
	/** Streaming token callback (answer arrives incrementally). */
	onToken?: (delta: string) => void;
	/** Stage callback: "connecting" | "sent" | "investigating" | "done" | "error". */
	onStage?: (stage: string) => void;
	/** Peer status push callback (tracker of the remote peer). */
	onStatus?: (peer: PeerInfo) => void;
	/** Override the synchronous wait timeout. */
	timeoutMs?: number;
	/** Abort the ask. */
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// IPC wire protocol (JSON-per-line framing over UDS)
// ---------------------------------------------------------------------------

export interface AskRequestData {
	question: string;
}

export interface AskResponseData {
	answer: string;
}

export interface IpcRequest {
	kind: "request";
	id: string;
	type: "ask" | "ping";
	data?: unknown;
}

export interface IpcResponse {
	kind: "response";
	id: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

export interface IpcEmit {
	kind: "emit";
	/** "status" = peer info push, "stage" = investigate stage, "token" = streamed delta. */
	type: "status" | "stage" | "token";
	data?: unknown;
}

export type IpcMessage = IpcRequest | IpcResponse | IpcEmit;

// ---------------------------------------------------------------------------
// PeekAgentAPI — the singleton surface (cross-instance)
// ---------------------------------------------------------------------------

export interface PeekAgentAPI {
	/** Update the recorded model id (on model_select). */
	updateModel(modelId: string): void;
	/** This instance's own identity (for display + registry marker). */
	getSelfInfo(): PeerInfo;
	/** List live peers (same-project first). Stale/crashed peers are pruned. */
	listPeers(): Promise<PeerInfo[]>;
	/** Resolve a target peer. Returns PeerInfo, an array (name collision), or undefined. */
	resolvePeer(opts: ResolvePeerOptions): Promise<PeerInfo | PeerInfo[] | undefined>;
	/** Ask a peer a question, blocking until the full answer returns. */
	askPeer(peer: PeerInfo, question: string, opts?: AskPeerOptions): Promise<string>;
	/** Count of live peers (for the statusbar widget). */
	countPeers(): Promise<number>;
}

/** Global key for the PeekAgentAPI singleton. */
export const PEEK_AGENT_GLOBAL_KEY = "__piPeekAgent";

/** Default UDS directory: $TMPDIR or /tmp. */
export function defaultSockDir(): string {
	const tmp = process.env["TMPDIR"] || process.env["TMP"] || "/tmp";
	return tmp.replace(/\/$/, "");
}

/** Default registry directory. */
export function defaultRegistryDir(): string {
	const home = process.env["HOME"] || "/tmp";
	return `${home}/.pi/peek/registry`;
}
