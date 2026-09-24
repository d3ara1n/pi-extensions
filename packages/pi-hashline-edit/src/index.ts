/**
 * pi-hashline-edit extension entry.
 *
 * Overrides the built-in read/edit: read outputs "lineNo#hash│content" by default;
 * edit accepts structured hashline ops (edits[] with LINE#HASH anchors), and
 * legacy oldText/newText is rejected explicitly (no silent degradation). grep
 * is overridden the same way so results carry usable anchors. A separate
 * `replace` tool adds location-blind bulk + regex replacement (replaceAll and
 * full JS regex with capture groups) for renames/pattern transforms that
 * would need many individual edits. Each tool carries its own renderer.
 *
 * @module pi-hashline-edit
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./pi/config.ts";
import { getState } from "./pi/state.ts";
import { makeEditOverride } from "./pi/edit-tool.ts";
import { makeReadOverride } from "./pi/read-tool.ts";
import { makeGrepOverride } from "./pi/grep-tool.ts";
import { makeReplaceTool } from "./pi/replace-tool.ts";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	const state = getState();
	state.config = loadConfig(cwd);

	// `enabled: false` leaves the extension fully inert — pi's built-in
	// read/edit/grep stay in place, as if this package were not installed.
	if (state.config.enabled) {
		pi.registerTool(makeReadOverride(cwd));
		pi.registerTool(makeEditOverride(cwd));
		pi.registerTool(makeGrepOverride(cwd));
		pi.registerTool(makeReplaceTool(cwd));
	}
}
