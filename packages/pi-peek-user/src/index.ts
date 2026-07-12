/**
 * pi-peek-user — user-facing /peek command that opens the local consult overlay.
 *
 * Asks THIS instance: the user questions their own session without disturbing
 * the main agent. Depends only on @d3ara1n/pi-peek (no cross-instance machinery).
 *
 * The overlay draws its own complete frame (header / answer / composer / info
 * panels separated by borders, bottom border holding hotkeys) so it never
 * blends into pi's own footer below it. A small bottom margin keeps the two
 * visually distinct.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PeekOverlay } from "./overlay.ts";

export default function registerPeekUserExtension(pi: ExtensionAPI): void {
  pi.registerCommand("peek", {
    description: "Aside consult: ask this session a question without disturbing the main agent",
    handler: async (_args, ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("peek overlay requires TUI mode", "warning");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _kb, done) => new PeekOverlay(tui, theme, done, ctx), {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "60%",
          maxHeight: "80%",
          margin: { bottom: 2 },
        },
      });
    },
  });
}
