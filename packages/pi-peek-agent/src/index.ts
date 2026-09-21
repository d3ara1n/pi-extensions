/**
 * pi-peek-agent — Extension entry point.
 *
 * Cross-instance peek, built on @d3ara1n/pi-mesh. This extension owns only the
 * peek business: it registers an "investigate" handler on the mesh (served via
 * @d3ara1n/pi-peek's local investigate(), read-after-burn) and exposes the
 * `peek` LLM tool. Discovery, transport, identity, and the `mesh_list` tool all
 * live in pi-mesh.
 *
 * Load order is NOT significant: we listen for pi-mesh's `mesh:ready` event
 * (catches mesh init that happens after we load) and fall back to
 * tryGetMeshAPI() in our own session_start (catches mesh init that happened
 * before or in the same pass). So pi-mesh and pi-peek-agent may appear in any
 * order in settings.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPeekAPI } from "@d3ara1n/pi-peek";
import { MESH_READY_EVENT, tryGetMeshAPI } from "@d3ara1n/pi-mesh";
import type { MeshAPI } from "@d3ara1n/pi-mesh";
import { registerPeekTool } from "./tool.ts";
import { INVESTIGATE_TYPE } from "./types.ts";
import type { InvestigateRequestData, InvestigateResponseData } from "./types.ts";

export default function registerPeekAgentExtension(pi: ExtensionAPI): void {
  let registered = false;

  // Register the "investigate" handler on the mesh. Idempotent (guarded by `registered`).
  // peekApi is resolved LAZILY inside the handler — by the time a remote investigation
  // arrives, pi-peek's session_start has long since run, so getPeekAPI() is safe
  // there and we don't depend on pi-peek's init timing either.
  function serveInvestigations(mesh: MeshAPI): void {
    if (registered) return;
    registered = true;
    mesh.serve(INVESTIGATE_TYPE, async (data, emit) => {
      const { question, includeThinking } = (data ?? {}) as InvestigateRequestData;
      const peekApi = getPeekAPI();
      const result = await peekApi.investigate(question ?? "", {
        includeThinking: includeThinking === true,
        onToken: (delta) => emit("token", { delta }),
        onStage: (stage) => emit("stage", { stage }),
      });
      return { report: result.report, snapshotAt: result.snapshotAt, usage: result.usage, stopReason: result.stopReason } satisfies InvestigateResponseData;
    });
  }

  // (a) mesh inits AFTER us → its session_start emits mesh:ready, we catch it.
  pi.events.on(MESH_READY_EVENT, (mesh: unknown) => serveInvestigations(mesh as MeshAPI));

  // (b) mesh inits BEFORE us, or in the same session_start pass → already on globalThis.
  pi.on("session_start", async (_event, ctx) => {
    const mesh = tryGetMeshAPI();
    if (!mesh) return; // waiting for the mesh:ready listener to fire
    serveInvestigations(mesh);
    if (ctx.hasUI) {
      ctx.ui.notify("pi-peek-agent ready (serving investigations on the mesh)", "info");
    }
  });

  registerPeekTool(pi);
}
