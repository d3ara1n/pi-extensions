/**
 * pi-mesh shared types.
 *
 * Agent mesh for pi: peer discovery + cross-instance transport. This is the
 * neutral foundation — it knows about sockets, registry markers, and other pi
 * instances, but NOTHING about peek, chat, or any specific workflow. Consumers
 * (pi-peek-agent, a future chat-room, ...) register typed handlers via
 * {@link MeshAPI.serve} and call {@link MeshAPI.connect} on top.
 *
 * Deliberately free of any @d3ara1n/pi-peek dependency: peer activity status
 * (tracker snapshots) belongs to peek's business layer, not the discovery layer.
 */

import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MeshConfig {
  /** Registry directory for PID-file markers. Default ~/.pi/mesh/registry. */
  registryDir?: string;
  /** How often to refresh our own marker's lastSeen. Default 15s. */
  heartbeatMs?: number;
}

export const DEFAULT_MESH_CONFIG: Required<Pick<MeshConfig, "heartbeatMs">> = {
  heartbeatMs: 15_000,
};

// ---------------------------------------------------------------------------
// Peer identity & profile
// ---------------------------------------------------------------------------

/**
 * Self-declared profile — the "name card" an instance shows on the mesh.
 *
 * Unlike {@link PeerInfo.name} (identity, stable per session), profile is the
 * runtime, agent/user-authored description of role and specialty. Set via
 * {@link MeshAPI.setProfile} (exposed to the LLM as the `mesh_set_profile`
 * tool) so an agent can self-introduce: "I'm the security lead — ask me about
 * auth/crypto". Workflow-agnostic: mesh transmits it but does not interpret it.
 */
export interface PeerProfile {
  /** Role/title, e.g. "security lead", "frontend designer", "assistant". */
  role?: string;
  /** Free-form specialties / when-to-consult description. */
  description?: string;
}

export interface PeerInfo {
  /** Unique instance id (crypto.randomUUID()). */
  sessionId: string;
  /** OS pid — used for liveness probing (kill(pid, 0)). */
  pid: number;
  /** UDS path to connect to. */
  sockPath: string;
  /** Display name — identity, renameable via {@link MeshAPI.setName}. */
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
  /** Self-declared role/specialty. See {@link PeerProfile}. */
  profile?: PeerProfile;
  /** True when multiple live peers share this name (name collision). */
  ambiguous?: boolean;
}

/** Tool result details for mesh_list — structured peers so the TUI can color by importance. */
export interface MeshListDetails {
  peers: PeerInfo[];
}

/** Tool result details for mesh_get_profile and mesh_set_profile — the peer
 * (resp. self) with its profile, structured for the TUI name card. */
export interface MeshGetProfileDetails {
  peer: PeerInfo;
}

export interface ResolvePeerOptions {
  /** Target by name. Omit to auto-pick the other same-project peer. */
  at?: string;
  /** Target by exact sessionId (wins over `at` on collision). */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Generic transport — request/response/emit over UDS, routed by `type`
// ---------------------------------------------------------------------------

/** Per-request options for {@link MeshConnection.request}. */
export interface RequestOptions {
  /** Override the synchronous wait timeout. */
  timeoutMs?: number;
  /** Abort the request. */
  signal?: AbortSignal;
  /**
   * Generic server→client emit callback. Consumers route by `type` themselves
   * (e.g. peek listens for "token"/"stage"). Mesh does not interpret emits.
   */
  onEmit?: (type: string, data: unknown) => void;
}

/** Server-side handler registered via {@link MeshAPI.serve}. */
export type ServeHandler = (data: unknown, emit: EmitFn) => Promise<unknown>;

/** Server→client emit during request handling. Generic; type is caller-defined. */
export type EmitFn = (type: string, data?: unknown) => void;

/** A live connection to a peer. One outstanding request at a time. */
export interface MeshConnection {
  /**
   * Send a typed request, resolve with the handler's returned data.
   * Emits arriving before the response are routed to opts.onEmit.
   */
  request(type: string, data: unknown, opts?: RequestOptions): Promise<unknown>;
  close(): void;
}

// ---------------------------------------------------------------------------
// IPC wire protocol (JSON-per-line framing over UDS)
// ---------------------------------------------------------------------------

export interface IpcRequest {
  kind: "request";
  id: string;
  /** Caller-defined request type, e.g. "ask", "message", "ping". */
  type: string;
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
  /** Caller-defined emit type, e.g. "token", "stage", "status". */
  type: string;
  data?: unknown;
}

export type IpcMessage = IpcRequest | IpcResponse | IpcEmit;

// ---------------------------------------------------------------------------
// MeshAPI — the singleton surface (cross-instance)
// ---------------------------------------------------------------------------

export interface MeshAPI {
  // ── identity (stable per session; name is renameable) ──────────────────
  /** This instance's own identity (for display + registry marker). */
  getSelfInfo(): PeerInfo;
  /** Update the recorded model id (on model_select). */
  updateModel(modelId: string): void;
  /** Override the display name (identity). Updates self + registry. */
  setName(name: string): void;

  // ── profile (runtime, role/specialty) ──────────────────────────────────
  /** Declare or update this instance's role/description. */
  setProfile(profile: Partial<PeerProfile>): void;
  /** This instance's current profile, if any. */
  getProfile(): PeerProfile | undefined;

  // ── discovery ──────────────────────────────────────────────────────────
  /** List live peers (same-project first). Stale/crashed peers are pruned. */
  listPeers(): Promise<PeerInfo[]>;
  /** Resolve a target peer. Returns PeerInfo, an array (collision), or undefined. */
  resolvePeer(opts?: ResolvePeerOptions): Promise<PeerInfo | PeerInfo[] | undefined>;
  /** Count of live peers (for the statusbar widget). */
  countPeers(): Promise<number>;

  // ── transport (server side) ────────────────────────────────────────────
  /**
   * Register a handler for incoming requests of `type`. Last writer wins per
   * type. Safe to call from session_start or later; the server listens
   * regardless of registration order, and requests only arrive once peers
   * discover us.
   */
  serve(type: string, handler: ServeHandler): void;

  // ── transport (client side) ────────────────────────────────────────────
  /** Open a connection to a peer. Caller must close() when done. */
  connect(peer: PeerInfo): Promise<MeshConnection>;
}

/** Global key for the MeshAPI singleton. */
export const MESH_GLOBAL_KEY = "__piMesh";

/** Event name emitted on pi.events once the mesh is initialized and serving.
 * Order-agnostic consumers listen for this instead of assuming load order. */
export const MESH_READY_EVENT = "mesh:ready";

// ---------------------------------------------------------------------------
// Default directories
// ---------------------------------------------------------------------------

/** Default IPC socket directory (POSIX). Windows uses named pipes, not a file path. */
export function defaultSockDir(): string {
  // os.tmpdir() is cross-platform: $TMPDIR on POSIX, %TEMP% on Windows.
  return os.tmpdir();
}

/** Default registry directory for PID-file markers. */
export function defaultMeshRegistryDir(): string {
  // os.homedir() resolves to $HOME on POSIX and %USERPROFILE% on Windows.
  return path.join(os.homedir(), ".pi", "mesh", "registry");
}
