import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Pull the constructor parameter types straight off CustomEditor so they are
// structurally identical to what `super(...)` expects. Importing TUI /
// EditorTheme from "@earendil-works/pi-tui" would resolve to this repo's
// top-level copy, which is a *different* declaration than the one nested
// inside @earendil-works/pi-coding-agent — the two are not assignable.
type CtorArgs = ConstructorParameters<typeof CustomEditor>;

// Box-drawing glyphs (U+2500 block). Supported by virtually every monospace
// font — no Nerd Font required for the frame itself.
const GLYPH = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  vertical: "│",
  // T-junction caps: used when autocomplete splits the card into two stacked
  // panes. ctx/cwd live on this divider so they always sit just under the
  // editor, regardless of whether the popup is open.
  divLeft: "├",
  divRight: "┤",
} as const;

/** Below this terminal width the frame hurts readability — fall back to default. */
const MIN_WIDTH = 20;

/** Braille spinner frames, advanced on a timer while the agent is working. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

const RESET = "\x1b[0m";

/**
 * Already-themed text segments to embed in the four border positions.
 * Empty string = no segment; the gap filler expands to fill the space.
 * The extension (not this class) is responsible for applying colors, so the
 * editor never has to touch the private `theme` field of the base Editor.
 */
export interface FrameSegments {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
}

/** Fresh, already-themed segments. The frame color itself comes from pi's
 *  editor.borderColor field (same source as the default editor), kept in
 *  sync by pi on thinking-level / bash-mode changes — so the border
 *  matches the built-in behavior.
 *
 *  (An optional `frame` override exists for experiments; when omitted the
 *  editor falls back to editor.borderColor.) */
export interface Frame {
  segments: FrameSegments;
  frame?: (s: string) => string;
}

/** Returns a fresh Frame on each render call. */
export type FrameProvider = () => Frame;

const EMPTY_FRAME: Frame = {
  segments: { topLeft: "", topRight: "", bottomLeft: "", bottomRight: "" },
  frame: (s) => s,
};

/** Strip ANSI SGR escapes and pi's zero-width cursor marker so a line can
 *  be inspected by visible content alone. Border rows never carry cursor
 *  markers or hyperlinks, so this light treatment is sufficient.
 *
 *  Control chars are built via String.fromCharCode so the regex source holds
 *  no literal escape sequences — that keeps linters that ban control
 *  characters inside regex literals happy while still matching real ESC/BEL. */
const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const CURSOR_MARKER = `${String.fromCharCode(27)}_pi:c${String.fromCharCode(7)}`;

function stripAnsi(s: string): string {
  return s.replace(SGR_RE, "").replaceAll(CURSOR_MARKER, "");
}

/** A horizontal border row is all box-drawing `─` (plus whitespace),
 *  optionally holding a scroll indicator like `↑ 3 more`. Anything else —
 *  editor content, autocomplete items — contains other visible glyphs. */
function isBorderRow(line: string): boolean {
  const core = stripAnsi(line).replace(/[─\s]/g, "");
  return core === "" || /^[↑↓]\d+more$/.test(core);
}

/**
 * Lay out one frame row: `leftCap leftText ──fill── rightText rightCap`,
 * total visible width == `width`. Caps and the `─` filler take `borderColor`;
 * the text segments are pre-themed by the caller. Long segments are
 * truncated (right first, then left) so a minimum gap survives.
 */
function fitFrameRow(
  leftCap: string,
  rightCap: string,
  leftText: string,
  rightText: string,
  width: number,
  border: (s: string) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return border(leftCap);
  if (width === 2) return `${border(leftCap)}${border(rightCap)}`;

  const inner = width - 2; // two caps
  const minGap = 3;
  let l = leftText;
  let r = rightText;

  while (visibleWidth(l) + visibleWidth(r) + minGap > inner && visibleWidth(r) > 0) {
    r = truncateToWidth(r, Math.max(0, visibleWidth(r) - 1), "");
  }
  while (visibleWidth(l) + visibleWidth(r) + minGap > inner && visibleWidth(l) > 0) {
    l = truncateToWidth(l, Math.max(0, visibleWidth(l) - 1), "");
  }

  const gap = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
  return `${border(leftCap)}${l}${border("─".repeat(gap))}${r}${border(rightCap)}`;
}

/**
 * Editor that wraps the built-in input area in a rounded-corner card frame,
 * with optional status text embedded in the top/bottom borders.
 *
 * The default Editor only draws a horizontal line above and below the content
 * (no side borders — see Editor.render). To get a closed box we render the
 * editor at `width - 2` and wrap every line with a left/right glyph, so the
 * total visible width still equals `width`. Each rendered line is computed
 * fresh every frame (no cached themed strings), so theme changes and
 * thinking/bash border-color shifts apply automatically with no invalidate
 * work needed. Border glyphs use `this.borderColor`, the same function pi
 * mutates to encode thinking level / bash mode, keeping the frame
 * semantically consistent.
 */
export class CardEditor extends CustomEditor {
  private readonly frameProvider?: FrameProvider;
  private working = false;
  private spinnerIdx = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;

  constructor(
    tui: CtorArgs[0],
    theme: CtorArgs[1],
    keybindings: CtorArgs[2],
    frameProvider?: FrameProvider,
  ) {
    super(tui, theme, keybindings, { paddingX: 1 });
    this.frameProvider = frameProvider;
  }

  /** Drive the working spinner from the agent_start/agent_end events.
   *  When active, the current spinner frame replaces the model text in the
   *  top border. */
  setWorking(active: boolean): void {
    if (active === this.working) return;
    this.working = active;
    if (active) {
      this.spinnerIdx = 0;
      this.spinnerTimer = setInterval(() => {
        this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
        this.tui.requestRender();
      }, SPINNER_INTERVAL_MS);
    } else {
      if (this.spinnerTimer) clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    // Too narrow — delegate to the default rendering, untouched.
    if (width < MIN_WIDTH) {
      return super.render(width);
    }

    // super.render(width - 2) guarantees every line's visible width == width - 2,
    // so wrapping each line with one glyph on each side lands exactly on `width`.
    const inner = super.render(width - 2);
    if (inner.length === 0) return inner;

    // Border color: prefer the provider's override when given, otherwise
    // fall back to pi's editor.borderColor (same field the default editor
    // reads, updated by pi on thinking / bash changes).
    const frameObj = this.frameProvider?.() ?? EMPTY_FRAME;
    const border = frameObj.frame ?? this.borderColor;
    const seg = frameObj.segments;
    // While working, the spinner frame takes over the top-left slot (it reads
    // as "active" more strongly than a static model label).
    const topLeft = this.working
      ? `${RESET}${border(` ${SPINNER_FRAMES[this.spinnerIdx] ?? "⠋"} `)}${seg.topLeft.trimStart()}`
      : seg.topLeft;

    // The default Editor appends autocomplete rows *after* the bottom border.
    // So the real bottom border is the last row that still looks like one —
    // not necessarily `inner.length - 1`. Treating an autocomplete item as
    // the bottom border (the old `i === last` check) fed it through
    // fitFrameRow, which truncated/filled the item text and rendered the
    // popup empty.
    let bottomIdx = inner.length - 1;
    while (bottomIdx > 0 && !isBorderRow(inner[bottomIdx])) bottomIdx--;
    // inner[0] is always the top border, so a real bottom border is ≥ 1.
    // (Editor.render always pushes one; this only guards the degenerate case.)
    if (bottomIdx === 0) bottomIdx = inner.length - 1;

    // When the popup is open, pi's bottom border sits *between* the editor
    // content and the popup items. We turn that middle border into a
    // T-junction divider (carrying ctx/cwd), wrap the popup items with the
    // same verticals as content, and close everything with a fresh rounded
    // bottom — one connected card, two panes.
    const hasPopup = bottomIdx < inner.length - 1;

    const out: string[] = [];
    for (let i = 0; i < inner.length; i++) {
      const line = inner[i];
      if (i === 0) {
        // Top border: rebuild with embedded status text (status takes
        // precedence over pi's plain ─ / "↑ N more" scroll indicator).
        out.push(fitFrameRow(GLYPH.topLeft, GLYPH.topRight, topLeft, seg.topRight, width, border));
      } else if (i === bottomIdx) {
        // ctx/cwd always sit just under the editor. With a popup below, this
        // border becomes a T-junction divider; without one it's the rounded
        // bottom of the card.
        out.push(
          hasPopup
            ? fitFrameRow(
                GLYPH.divLeft,
                GLYPH.divRight,
                seg.bottomLeft,
                seg.bottomRight,
                width,
                border,
              )
            : fitFrameRow(
                GLYPH.bottomLeft,
                GLYPH.bottomRight,
                seg.bottomLeft,
                seg.bottomRight,
                width,
                border,
              ),
        );
      } else {
        // Content row and popup items alike live inside the card. Reset around
        // the text so its styling never leaks into the frame and vice versa.
        out.push(`${border(GLYPH.vertical)}${RESET}${line}${RESET}${border(GLYPH.vertical)}`);
      }
    }
    // The popup extends the card — close it with an empty rounded bottom.
    if (hasPopup) {
      out.push(fitFrameRow(GLYPH.bottomLeft, GLYPH.bottomRight, "", "", width, border));
    }
    return out;
  }
}
