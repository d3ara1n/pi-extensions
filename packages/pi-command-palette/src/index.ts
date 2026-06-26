/**
 * pi-command-palette — Global command palette for pi.
 *
 * Press Ctrl+Shift+P to open a searchable command palette overlay,
 * regardless of whether the editor has content.
 *
 * Features:
 * - Lists extension commands, skills, and prompt templates (from pi.getCommands())
 * - Built-in actions: model selector, new session, compact, reload
 * - Fuzzy search via SelectList
 * - Floating overlay on top of existing content
 * - Saves editor text before overwriting; offers "Restore" in palette
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	fuzzyFilter,
	Key,
	matchesKey,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import { resolveShortcutKey } from "./config.ts";

// ── Types ──────────────────────────────────────────────────────────

type CommandAction =
	| { type: "editor"; text: string }
	| { type: "model-select" }
	| { type: "compact" }
	| { type: "reload" }
	| { type: "restore" };

interface PaletteItem {
	value: string;
	label: string;
	description: string;
	category: string;
	action: CommandAction;
}

// ── Module state ───────────────────────────────────────────────────

/** Editor text saved before the palette overwrites it. */
let savedEditorText: string | null = null;

// ── Helpers ────────────────────────────────────────────────────────

function buildPaletteItems(pi: ExtensionAPI, ctx: ExtensionContext): PaletteItem[] {
	const items: PaletteItem[] = [];

	// ── Restore option (if previous editor text was saved) ────────
	if (savedEditorText) {
		const preview =
			savedEditorText.length > 40
				? `${savedEditorText.slice(0, 37)}...`
				: savedEditorText;
		items.push({
			value: "__restore",
			label: "Restore: Previous Editor Text",
			description: preview.replace(/\n/g, "⏎"),
			category: "Built-in",
			action: { type: "restore" },
		});
	}

	// ── Built-in actions ──────────────────────────────────────────
	items.push({
		value: "__model_select",
		label: "Model: Switch Model",
		description: "Select a model from the registry",
		category: "Built-in",
		action: { type: "model-select" },
	});

	items.push({
		value: "__new_session",
		label: "Session: New",
		description: "Start a new session",
		category: "Built-in",
		action: { type: "editor", text: "/new" },
	});

	items.push({
		value: "__compact",
		label: "Session: Compact",
		description: "Compact conversation to free context",
		category: "Built-in",
		action: { type: "compact" },
	});

	items.push({
		value: "__reload",
		label: "Session: Reload",
		description: "Reload extensions, skills, and config",
		category: "Built-in",
		action: { type: "reload" },
	});

	items.push({
		value: "__fork",
		label: "Session: Fork",
		description: "Fork from selected entry",
		category: "Built-in",
		action: { type: "editor", text: "/fork" },
	});

	items.push({
		value: "__tree",
		label: "Session: Tree",
		description: "Navigate session tree",
		category: "Built-in",
		action: { type: "editor", text: "/tree" },
	});

	items.push({
		value: "__resume",
		label: "Session: Resume",
		description: "Resume a previous session",
		category: "Built-in",
		action: { type: "editor", text: "/resume" },
	});

	// ── Extension commands, skills, templates ────────────────────
	const commands = pi.getCommands();
	for (const cmd of commands) {
		const editorText = `/${cmd.name}`;
		const sourceLabel =
			cmd.source === "extension"
				? "Command"
				: cmd.source === "skill"
					? "Skill"
					: "Template";

		items.push({
			value: `cmd:${cmd.name}`,
			label: `${sourceLabel}: /${cmd.name}`,
			description: cmd.description ?? "",
			category: sourceLabel,
			action: { type: "editor", text: editorText },
		});
	}

	// Sort: built-in first, then alphabetically within category
	items.sort((a, b) => {
		if (a.category === "Built-in" && b.category !== "Built-in") return -1;
		if (a.category !== "Built-in" && b.category === "Built-in") return 1;
		return a.label.localeCompare(b.label);
	});

	return items;
}

// ── Model selector ─────────────────────────────────────────────────

async function showModelSelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	let models: Awaited<ReturnType<typeof ctx.modelRegistry.getAvailable>>;
	try {
		models = await ctx.modelRegistry.getAvailable();
	} catch {
		ctx.ui.notify("Cannot enumerate models. Use Ctrl+L instead.", "warning");
		return;
	}

	if (models.length === 0) {
		ctx.ui.notify("No models available.", "warning");
		return;
	}

	const items: SelectItem[] = models.map((m) => ({
		value: `${m.provider}/${m.id}`,
		label: m.name,
		description: m.provider,
	}));

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Switch Model")), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		// Type-to-filter state
		let query = "";
		const queryText = new Text(theme.fg("accent", "> "), 1, 0);

		function applyQuery() {
			const filtered = query
				? fuzzyFilter(items, query, (item: SelectItem) => `${item.label} ${item.description ?? ""}`)
				: items;
			(selectList as any).filteredItems = filtered;
			selectList.setSelectedIndex(0);
			queryText.setText(theme.fg("accent", `> ${query}▎`));
			container.invalidate();
			tui.requestRender();
		}

		container.addChild(queryText);
		container.addChild(selectList);
		container.addChild(
			new Text(theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"), 1, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(w: number) {
				return container.render(w);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// Backspace → trim query
				if (matchesKey(data, Key.backspace)) {
					if (query.length > 0) {
						query = query.slice(0, -1);
						applyQuery();
					}
					return;
				}
				// Printable character → append to query
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					query += data;
					applyQuery();
					return;
				}
				// Navigation / confirm / cancel → pass to SelectList
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });

	if (!result) return;

	const [provider, modelId] = result.split("/");
	const model = ctx.modelRegistry.find(provider, modelId);
	if (model) {
		const success = await pi.setModel(model);
		if (success) {
			ctx.ui.notify(`Model: ${provider}/${modelId}`, "info");
		} else {
			ctx.ui.notify(`No API key for ${provider}/${modelId}`, "error");
		}
	}
}

// ── Command palette overlay ────────────────────────────────────────

async function showCommandPalette(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const paletteItems = buildPaletteItems(pi, ctx);
	const selectItems: SelectItem[] = paletteItems.map((item) => ({
		value: item.value,
		label: item.label,
		description: item.description,
	}));

	const result = await ctx.ui.custom<PaletteItem | null>(
		(tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Command Palette")), 1, 0),
			);

			const selectList = new SelectList(selectItems, Math.min(selectItems.length, 15), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});

			selectList.onSelect = (item) => {
				const paletteItem = paletteItems.find((p) => p.value === item.value);
				done(paletteItem ?? null);
			};
			selectList.onCancel = () => done(null);

			// Type-to-filter state
			let query = "";
			const queryText = new Text(theme.fg("accent", "> "), 1, 0);

			function applyQuery() {
				const filtered = query
					? fuzzyFilter(selectItems, query, (item: SelectItem) => `${item.label} ${item.description ?? ""}`)
					: selectItems;
				(selectList as any).filteredItems = filtered;
				selectList.setSelectedIndex(0);
				queryText.setText(theme.fg("accent", `> ${query}▎`));
				container.invalidate();
				tui.requestRender();
			}

			container.addChild(queryText);
			container.addChild(selectList);
			container.addChild(
				new Text(theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"), 1, 0),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render(w: number) {
					return container.render(w);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					// Backspace → trim query
					if (matchesKey(data, Key.backspace)) {
						if (query.length > 0) {
							query = query.slice(0, -1);
							applyQuery();
						}
						return;
					}
					// Printable character → append to query
					if (data.length === 1 && data.charCodeAt(0) >= 32) {
						query += data;
						applyQuery();
						return;
					}
					// Navigation / confirm / cancel → pass to SelectList
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true },
	);

	if (!result) return;

	// Execute the selected action
	const action = result.action;
	switch (action.type) {
		case "restore": {
			if (savedEditorText !== null) {
				ctx.ui.setEditorText(savedEditorText);
				savedEditorText = null;
			}
			break;
		}
		case "editor": {
			// Save current editor text before overwriting, so user can restore
			const currentText = ctx.ui.getEditorText();
			if (currentText && currentText.trim()) {
				savedEditorText = currentText;
			}
			ctx.ui.setEditorText(action.text);
			break;
		}
		case "model-select": {
			await showModelSelector(pi, ctx);
			break;
		}
		case "compact": {
			ctx.compact({
				onComplete: () => ctx.ui.notify("Compaction completed", "info"),
				onError: (err) => ctx.ui.notify(`Compaction failed: ${err.message}`, "error"),
			});
			break;
		}
		case "reload": {
			const currentText = ctx.ui.getEditorText();
			if (currentText && currentText.trim()) {
				savedEditorText = currentText;
			}
			ctx.ui.setEditorText("/reload");
			break;
		}
	}
}

// ── Extension entry point ──────────────────────────────────────────

export default function commandPaletteExtension(pi: ExtensionAPI) {
	pi.registerShortcut(resolveShortcutKey(), {
		description: "Open command palette",
		handler: async (ctx) => {
			await showCommandPalette(pi, ctx);
		},
	});
}
