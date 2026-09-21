/**
 * pi-peek-user — user-facing /peek command that opens the local investigation overlay.
 *
 * Investigates THIS instance: the user inspects their own session without
 * disturbing the main agent. Depends only on @d3ara1n/pi-peek (no cross-instance machinery).
 *
 * The overlay draws its own complete frame (header / report / composer / info
 * panels separated by borders, bottom border holding hotkeys) so it never
 * blends into pi's own footer below it. A small bottom margin keeps the two
 * visually distinct.
 *
 * Entry points: the `/peek` slash command and a native command-palette entry
 * (registered via @d3ara1n/pi-command-palette-core) that opens the same
 * overlay directly — usable mid-draft, since it never touches the editor.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";
import { PeekOverlay } from "./overlay.ts";
import type { PeekReferenceOptions } from "@d3ara1n/pi-peek";

async function openPeekOverlay(ctx: ExtensionContext, options: PeekReferenceOptions = {}): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("peek overlay requires TUI mode", "warning");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _kb, done) => new PeekOverlay(tui, theme, done, ctx, undefined, options), {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "60%",
      maxHeight: "80%",
      margin: { bottom: 2 },
    },
  });
}

export default function registerPeekUserExtension(pi: ExtensionAPI): void {
  pi.registerCommand("peek", {
    description: "Aside investigation: inspect this session without disturbing the main agent",
    handler: async (_args, ctx: ExtensionContext) => {
      await openPeekOverlay(ctx);
    },
  });

  pi.registerCommand("peek:thinking", {
    description: "Inspect this session with its recorded thinking included",
    handler: async (_args, ctx: ExtensionContext) => {
      await openPeekOverlay(ctx, { includeThinking: true });
    },
  });

  paletteCommandRegistry.register({
    id: "peek-user:open",
    label: "Peek: Inspect This Session",
    description: "Inspect this session without disturbing the main agent",
    run: (_pi, ctx) => openPeekOverlay(ctx),
  });
}
