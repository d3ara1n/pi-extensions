/**
 * Read editor-shell configuration from settings files.
 *
 * Global (~/.pi/agent/settings.json) + project (.pi/settings.json).
 * Project settings, when present, override global wholesale — standard
 * "project wins" design, no field-level merging.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Border icon slots that users can override. Each holds a single glyph
 *  (Nerd Font codepoint, Unicode symbol, or emoji) — whatever the user's
 *  terminal can render. Defaults live next to the renderer in index.ts. */
export interface EditorShellIcons {
  model: string;
  thinking: string;
  context: string;
  cache: string;
  hitRate: string;
  folder: string;
}

/** How the model is shown in the top-left border slot. */
export type ModelDisplay = "name" | "provider-id";

export interface EditorShellConfig {
  /**
   * Status keys to pin to the shell's top-right corner.
   * Only keys set via ctx.ui.setStatus() are eligible.
   */
  pinnedStatus: string[];
  /**
   * Per-slot border-icon overrides. Any subset; missing keys fall back to
   * the built-in Nerd Font set. Values are raw characters — JSON `"\uf0e7"`
   * for a Nerd Font glyph, or `"🤖"` for an emoji, etc.
   */
  icons: Partial<EditorShellIcons>;
  /**
   * What to show as the model label in the top-left border.
   * - `"name"` — `model.name` (friendlier; falls back to the id when a model
   *   has no name, so it never goes blank).
   * - `"provider-id"` — `provider/id`.
   */
  modelDisplay: ModelDisplay;
}

const ICON_KEYS: ReadonlyArray<keyof EditorShellIcons> = [
  "model",
  "thinking",
  "context",
  "cache",
  "hitRate",
  "folder",
];

/** Keep only known icon slots with string values — silently drops typos and
 *  wrong-typed entries so a bad config never crashes the renderer. */
function filterIcons(obj: Record<string, unknown>): Partial<EditorShellIcons> {
  const out: Partial<EditorShellIcons> = {};
  for (const key of ICON_KEYS) {
    const v = obj[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

export const DEFAULT_CONFIG: EditorShellConfig = {
  pinnedStatus: [],
  icons: {},
  modelDisplay: "name",
};

function getAgentDir(): string {
  const envDir = process.env.PI_AGENT_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".pi", "agent");
}

/** Read the `editorShell` block from a settings file.
 *  Returns undefined on missing file / parse error / non-object value —
 *  pi surfaces its own settings errors, this loader stays lenient. */
function readEditorShell(filePath: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"))?.editorShell;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load editorShell config. Project overrides global wholesale.
 * @param cwd - Project working directory
 */
export function loadEditorShellConfig(cwd?: string): EditorShellConfig {
  const globalRaw = readEditorShell(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readEditorShell(path.join(cwd, ".pi", "settings.json")) : undefined;
  const raw = projectRaw ?? globalRaw;
  if (!raw) return { ...DEFAULT_CONFIG };

  const pinned = raw.pinnedStatus;
  const iconsRaw = raw.icons;
  const modelDisplayRaw = raw.modelDisplay;
  const modelDisplay =
    modelDisplayRaw === "name" || modelDisplayRaw === "provider-id"
      ? modelDisplayRaw
      : DEFAULT_CONFIG.modelDisplay;
  return {
    pinnedStatus: Array.isArray(pinned)
      ? pinned.filter((k): k is string => typeof k === "string")
      : DEFAULT_CONFIG.pinnedStatus,
    icons:
      iconsRaw && typeof iconsRaw === "object"
        ? filterIcons(iconsRaw as Record<string, unknown>)
        : {},
    modelDisplay,
  };
}
